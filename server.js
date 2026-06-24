const express = require('express');
const https = require('https');
const http = require('http');
const { parseString } = require('xml2js');
const cron = require('node-cron');
const path = require('path');
const fs = require('fs');
const GEO = require('./geo-data.js');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Flat index of all known locations (id -> record) ──────────────────────
const GEO_INDEX = {};
for (const category of Object.values(GEO)) {
  for (const loc of category) GEO_INDEX[loc.id] = loc;
}

// ── Status cache ──────────────────────────────────────────────────────────
let statusCache = {
  services: {},
  incidents: [],
  rss: [],
  downdetector: [],
  endpoints: [],
  changes: [],
  geo: { points: [], hotspots: [] },
  lastUpdated: null
};

const STATE_FILE = '/run/status-state.json';

function loadPreviousState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return {}; }
}

function saveCurrentState(state) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state)); }
  catch {}
}

function detectChanges(oldState, newState) {
  const changes = [];
  for (const [key, newVal] of Object.entries(newState)) {
    const oldVal = oldState[key];
    if (!oldVal) {
      if (newVal.status !== 'operational' && newVal.status !== 'good') {
        changes.push({ type: 'new_issue', service: key, status: newVal.status, message: newVal.message || `${key} is now ${newVal.status}` });
      }
    } else if (oldVal.status !== newVal.status) {
      changes.push({
        type: 'status_change',
        service: key,
        oldStatus: oldVal.status,
        newStatus: newVal.status,
        message: `${key} changed from ${oldVal.status} to ${newVal.status}`
      });
    }
  }
  for (const [key, oldVal] of Object.entries(oldState)) {
    if (!newState[key] && oldVal.status !== 'operational' && oldVal.status !== 'good') {
      changes.push({ type: 'resolved', service: key, message: `${key} appears to have recovered` });
    }
  }
  return changes;
}

// ── HTTP helpers ──────────────────────────────────────────────────────────
function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, { timeout: 15000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function fetchXML(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, { timeout: 15000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        parseString(data, (err, result) => err ? reject(err) : resolve(result));
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function fetchText(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, { timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; StatusMonitor/1.0)' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ── Service fetchers ──────────────────────────────────────────────────────
async function fetchOCI() {
  try {
    const [components, status] = await Promise.all([
      fetchJSON('https://ocistatus.oraclecloud.com/api/v2/components.json'),
      fetchJSON('https://ocistatus.oraclecloud.com/api/v2/status.json')
    ]);
    const services = {};
    const seen = new Set();
    for (const c of (components.components || [])) {
      if (seen.has(c.name)) continue;
      seen.add(c.name);
      services[`oci_${c.name}`] = { name: c.name, status: c.status, provider: 'Oracle OCI' };
    }
    return { services, status: status.status?.indicator || 'none', description: status.status?.description || '' };
  } catch (e) { console.error('OCI fetch failed:', e.message); return { services: {}, status: 'unknown' }; }
}

async function fetchAzureStatus() {
  try {
    const result = await fetchXML('https://rssfeed.azure.status.microsoft/en-us/status/feed/');
    const items = result?.rss?.channel?.[0]?.item || [];
    const services = {};
    for (const item of items.slice(0, 5)) {
      const title = item.title?.[0] || '';
      const desc = (item.description?.[0] || '').toLowerCase();
      let status = 'operational';
      if (desc.includes('critical') || desc.includes('major')) status = 'major_outage';
      else if (desc.includes('warning') || desc.includes('degraded')) status = 'degraded';
      else if (desc.includes('information')) status = 'informational';
      services[`azure_${title}`] = { name: `Azure: ${title}`, status, provider: 'Microsoft Azure' };
    }
    return { services };
  } catch { return { services: {} }; }
}

async function fetchCloudflareStatus() {
  try {
    const [summary, components] = await Promise.all([
      fetchJSON('https://www.cloudflarestatus.com/api/v2/summary.json'),
      fetchJSON('https://www.cloudflarestatus.com/api/v2/components.json')
    ]);
    const services = {};
    for (const c of (components.components || [])) {
      services[`cf_${c.name}`] = { name: `Cloudflare: ${c.name}`, status: c.status, provider: 'Cloudflare' };
    }
    return { services, status: summary.status?.indicator || 'none' };
  } catch { return { services: {} }; }
}

async function fetchAWSStatus() {
  try {
    const html = await fetchText('https://health.aws.amazon.com/health/status');
    const services = {};
    const statusMatch = html.match(/"overallStatus"\s*:\s*"([^"]+)"/);
    const overallStatus = statusMatch ? statusMatch[1].toLowerCase() : 'informational';
    services['aws_overall'] = { name: 'AWS Overall', status: overallStatus === 'informational' ? 'operational' : overallStatus, provider: 'AWS' };

    const rss = await fetchXML('https://status.aws.amazon.com/rss/all.rss');
    const items = rss?.rss?.channel?.[0]?.item || [];
    for (const item of items.slice(0, 5)) {
      const title = item.title?.[0] || '';
      const desc = (item.description?.[0] || '').toLowerCase();
      let st = 'operational';
      if (desc.includes('outage') || desc.includes('impaired')) st = 'degraded';
      else if (desc.includes('disruption')) st = 'major_outage';
      services[`aws_${title.substring(0, 50)}`] = { name: `AWS: ${title}`, status: st, provider: 'AWS' };
    }
    return { services };
  } catch { return { services: {} }; }
}

async function fetchM365Status() {
  try {
    const result = await fetchXML('https://status.cloud.microsoft/api/v2/managedRSS');
    const items = result?.rss?.channel?.[0]?.item || [];
    const services = {};
    for (const item of items.slice(0, 3)) {
      const title = item.title?.[0] || '';
      const desc = (item.description?.[0] || '').toLowerCase();
      let st = 'operational';
      if (desc.includes('major') || desc.includes('critical')) st = 'major_outage';
      else if (desc.includes('degraded') || desc.includes('issue')) st = 'degraded';
      services[`m365_${title.substring(0, 50)}`] = { name: `M365: ${title}`, status: st, provider: 'Microsoft 365' };
    }
    return { services };
  } catch { return { services: {} }; }
}

async function fetchGCPStatus() {
  try {
    const result = await fetchJSON('https://status.cloud.google.com/incidents.json');
    const services = {};
    const incidents = Array.isArray(result) ? result.slice(0, 5) : [];
    for (const inc of incidents) {
      const desc = (inc.external_desc || inc.summary || '').toLowerCase();
      let st = 'operational';
      if (desc.includes('outage') || desc.includes('major')) st = 'major_outage';
      else if (desc.includes('degraded') || desc.includes('disruption')) st = 'degraded';
      else if (desc.includes('issue') || desc.includes('impact')) st = 'possible_issues';
      const components = (inc.affected_products || []).map(p => p.product_name || p).join(', ') || 'GCP';
      services[`gcp_${inc.incident_id || 'unknown'}`] = { name: `GCP: ${components}`, status: st, provider: 'Google Cloud', description: inc.external_desc?.substring(0, 200) || '' };
    }
    return { services };
  } catch { return { services: {} }; }
}

async function fetchDigitalOceanStatus() {
  try {
    const result = await fetchJSON('https://status.digitalocean.com/api/v2/summary.json');
    const services = {};
    for (const c of (result.components || [])) {
      let st = 'operational';
      if (c.status === 'major_outage') st = 'major_outage';
      else if (c.status === 'partial_outage' || c.status === 'degraded_performance') st = 'degraded';
      else if (c.status === 'under_maintenance') st = 'informational';
      services[`do_${c.name}`] = { name: `DO: ${c.name}`, status: st, provider: 'DigitalOcean' };
    }
    return { services, status: result.status?.indicator || 'none' };
  } catch { return { services: {} }; }
}

async function fetchFastlyStatus() {
  try {
    const result = await fetchJSON('https://status.fastly.com/api/v2/summary.json');
    const services = {};
    for (const c of (result.components || [])) {
      let st = 'operational';
      if (c.status === 'major_outage') st = 'major_outage';
      else if (c.status === 'partial_outage' || c.status === 'degraded_performance') st = 'degraded';
      else if (c.status === 'under_maintenance') st = 'informational';
      services[`fastly_${c.name}`] = { name: `Fastly: ${c.name}`, status: st, provider: 'Fastly' };
    }
    return { services, status: result.status?.indicator || 'none' };
  } catch { return { services: {} }; }
}

async function fetchAkamaiStatus() {
  try {
    const result = await fetchJSON('https://www.akamai.com/status-detailed.json');
    const services = {};
    if (result?.n?.status) {
      let st = 'operational';
      const s = result.n.status.toLowerCase();
      if (s.includes('outage') || s.includes('major')) st = 'major_outage';
      else if (s.includes('degraded') || s.includes('issue')) st = 'degraded';
      services['akamai_core'] = { name: 'Akamai Core CDN', status: st, provider: 'Akamai', description: result.n.status };
    }
    return { services };
  } catch { return { services: {} }; }
}

async function fetchVeeamStatus() {
  try {
    const html = await fetchText('https://status.veeam.com/');
    const services = {};
    const hasIssues = html.includes('degraded') || html.includes('outage') || html.includes('incident');
    services['veeam_cloud'] = { name: 'Veeam Cloud Connect', status: hasIssues ? 'degraded' : 'operational', provider: 'Veeam' };
    return { services };
  } catch { return { services: {} }; }
}

async function fetchConnectWiseStatus() {
  try {
    const result = await fetchJSON('https://status.connectwise.com/api/v2/summary.json');
    const services = {};
    for (const c of (result.components || [])) {
      let st = 'operational';
      if (c.status === 'major_outage') st = 'major_outage';
      else if (c.status === 'partial_outage' || c.status === 'degraded_performance') st = 'degraded';
      else if (c.status === 'under_maintenance') st = 'informational';
      services[`cw_${c.name}`] = { name: `ConnectWise: ${c.name}`, status: st, provider: 'ConnectWise' };
    }
    return { services, status: result.status?.indicator || 'none' };
  } catch { return { services: {} }; }
}

async function fetchKaseyaStatus() {
  try {
    const result = await fetchJSON('https://status.kaseya.com/api/v2/summary.json');
    const services = {};
    for (const c of (result.components || [])) {
      let st = 'operational';
      if (c.status === 'major_outage') st = 'major_outage';
      else if (c.status === 'partial_outage' || c.status === 'degraded_performance') st = 'degraded';
      else if (c.status === 'under_maintenance') st = 'informational';
      services[`kaseya_${c.name}`] = { name: `Kaseya: ${c.name}`, status: st, provider: 'Kaseya' };
    }
    return { services, status: result.status?.indicator || 'none' };
  } catch { return { services: {} }; }
}

async function fetchDattoStatus() {
  try {
    const result = await fetchJSON('https://status.datto.com/api/v2/summary.json');
    const services = {};
    for (const c of (result.components || [])) {
      let st = 'operational';
      if (c.status === 'major_outage') st = 'major_outage';
      else if (c.status === 'partial_outage' || c.status === 'degraded_performance') st = 'degraded';
      else if (c.status === 'under_maintenance') st = 'informational';
      services[`datto_${c.name}`] = { name: `Datto: ${c.name}`, status: st, provider: 'Datto' };
    }
    return { services, status: result.status?.indicator || 'none' };
  } catch { return { services: {} }; }
}

async function fetchAgilysysStatus() {
  try {
    const html = await fetchText('https://www.agilysys.com/status');
    const services = {};
    const hasIssues = html.includes('degraded') || html.includes('outage');
    services['agilysys_cloud'] = { name: 'Agilysys Cloud', status: hasIssues ? 'degraded' : 'operational', provider: 'Agilysys' };
    return { services };
  } catch { return { services: {} }; }
}

async function fetchOracleRSS() {
  try {
    const result = await fetchXML('https://ocistatus.oraclecloud.com/api/v2/incident-summary.rss');
    const items = result?.rss?.channel?.[0]?.item || [];
    return items.slice(0, 15).map(item => ({
      title: item.title?.[0] || '',
      description: (item.description?.[0] || '').replace(/<[^>]*>/g, '').substring(0, 300),
      link: item.link?.[0] || '',
      pubDate: item.pubDate?.[0] || '',
      source: 'Oracle OCI'
    }));
  } catch { return []; }
}

async function fetchDownDetectorServices() {
  const services = [
    // Cloud & Infrastructure
    { name: 'Oracle Cloud', slug: 'oracle-cloud', geoIds: ['oc-us-ashburn', 'oc-eu-frankfurt', 'oc-ap-tokyo'] },
    { name: 'Oracle Hospitality/Opera', slug: 'oracle-hospitality', geoIds: ['pms-opera', 'pms-opera-emea', 'pms-opera-apac'] },
    { name: 'AWS', slug: 'amazon-web-services-aws', geoIds: ['aws-va', 'aws-or', 'aws-ie'] },
    { name: 'Azure', slug: 'microsoft-azure', geoIds: ['az-va', 'az-nl', 'az-uk'] },
    { name: 'Google Cloud', slug: 'google-cloud-platform', geoIds: ['gcp-us-va', 'gcp-eu-nl'] },
    { name: 'Cloudflare', slug: 'cloudflare', geoIds: ['cf-nyc', 'cf-lon', 'cf-tok'] },
    { name: 'Microsoft 365', slug: 'microsoft-office-365', geoIds: ['az-va'] },
    { name: 'Microsoft Teams', slug: 'microsoft-teams', geoIds: ['col-teams'] },
    { name: 'DigitalOcean', slug: 'digital-ocean', geoIds: ['host-do'] },
    // Payment & POS
    { name: 'Visa', slug: 'visa', geoIds: ['visa-us', 'visa-eu'] },
    { name: 'Mastercard', slug: 'mastercard', geoIds: ['mc-us', 'mc-eu'] },
    { name: 'Stripe', slug: 'stripe', geoIds: ['stripe-us'] },
    { name: 'Square', slug: 'square', geoIds: ['pos-square'] },
    { name: 'Toast', slug: 'toast', geoIds: ['pos-toast', 'pos-toast-us'] },
    { name: 'Clover', slug: 'clover', geoIds: ['pos-clover'] },
    { name: 'Worldpay', slug: 'worldpay', geoIds: ['pos-worldpay'] },
    { name: 'Adyen', slug: 'adyen', geoIds: ['pos-adyen'] },
    // ITSM & RMM
    { name: 'ServiceNow', slug: 'servicenow', geoIds: ['itsm-snow-us', 'itsm-snow-uk'] },
    { name: 'Datto', slug: 'datto', geoIds: ['rmm-datto', 'rmm-datto-uk'] },
    { name: 'Kaseya', slug: 'kaseya', geoIds: ['rmm-kaseya', 'rmm-kaseya-dub'] },
    { name: 'ConnectWise', slug: 'connectwise', geoIds: ['rmm-cw'] },
    { name: 'Jira', slug: 'atlassian-jira', geoIds: ['itsm-jira-au', 'itsm-jira-us'] },
    { name: 'Freshservice', slug: 'freshservice', geoIds: ['itsm-fresh'] },
    // PMS & Hospitality
    { name: 'Agilysys', slug: 'agilysys', geoIds: ['pms-agilysys'] },
    { name: 'Oracle MICROS', slug: 'oracle-micros', geoIds: ['pos-micros', 'pos-micros-uk'] },
    { name: 'SiteMinder', slug: 'siteminder', geoIds: ['pms-site-minder'] },
    { name: 'Lightspeed', slug: 'lightspeed', geoIds: ['pos-lightspeed'] },
    // Collaboration & Comms
    { name: 'Zoom', slug: 'zoom', geoIds: ['col-zoom'] },
    { name: 'Slack', slug: 'slack', geoIds: ['col-slack'] },
    { name: 'Cisco Webex', slug: 'cisco-webex', geoIds: ['col-webex'] },
    // Hosting & CDN
    { name: 'GoDaddy', slug: 'godaddy', geoIds: ['host-godaddy'] },
    { name: 'Akamai', slug: 'akamai', geoIds: ['cdn-akamai-va', 'cdn-akamai-lon'] },
    // Backup & DR
    { name: 'Veeam', slug: 'veeam', geoIds: ['bkp-veeam', 'bkp-veeam-de'] },
    { name: 'Acronis', slug: 'acronis', geoIds: ['bkp-acronis', 'bkp-acronis-us'] },
    // Monitoring
    { name: 'Datadog', slug: 'datadog', geoIds: ['mon-datadog'] },
    { name: 'PRTG', slug: 'prtg', geoIds: ['mon-prtg'] },
    // Identity
    { name: 'Okta', slug: 'okta', geoIds: ['idp-okta', 'idp-okta-uk'] },
  ];
  const results = [];

  for (const svc of services) {
    try {
      const html = await fetchText(`https://downdetector.com/status/${svc.slug}/`);
      const reportMatch = html.match(/(\d[\d,]*)\s*(?:reports|problems)/i);
      const reports = reportMatch ? parseInt(reportMatch[1].replace(/,/g, '')) : 0;
      let status = 'operational';
      if (html.includes('Problems detected') || html.includes('problems-detected')) status = 'issues';
      else if (html.includes('Possible problems') || html.includes('possible-problems')) status = 'possible_issues';
      results.push({ name: svc.name, reports, status, source: 'DownDetector', geoIds: svc.geoIds });
    } catch {
      results.push({ name: svc.name, reports: 0, status: 'unknown', source: 'DownDetector', geoIds: svc.geoIds });
    }
  }
  return results;
}

async function fetchOracleRSS() {
  const feeds = [
    { url: 'https://www.oracle.com/rss/feeds/cloud-news.xml', source: 'Oracle Cloud News' },
    { url: 'https://ocistatus.oraclecloud.com/api/v2/incident-summary.rss', source: 'OCI Incidents' },
    { url: 'https://www.oracle.com/rss/feeds/hospitality-news.xml', source: 'Oracle Hospitality' },
  ];
  const allItems = [];
  for (const feed of feeds) {
    try {
      const result = await fetchXML(feed.url);
      const items = result?.rss?.channel?.[0]?.item || [];
      allItems.push(...items.slice(0, 10).map(item => ({
        title: item.title?.[0] || '',
        description: (item.description?.[0] || '').replace(/<[^>]*>/g, '').substring(0, 300),
        link: item.link?.[0] || '',
        pubDate: item.pubDate?.[0] || '',
        source: feed.source
      })));
    } catch {}
  }
  return allItems.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate)).slice(0, 30);
}

async function checkEndpoints() {
  const endpoints = [
    { name: 'Oracle OCI Status', url: 'https://ocistatus.oraclecloud.com/api/v2/status.json' },
    { name: 'Oracle Hospitality', url: 'https://www.oracle.com/hospitality/' },
    { name: 'Oracle MICROS', url: 'https://www.oracle.com/industries/hospitality/restaurant/' },
    { name: 'Azure Status', url: 'https://azure.status.microsoft/' },
    { name: 'AWS Status', url: 'https://health.aws.amazon.com/health/status' },
    { name: 'Google Cloud', url: 'https://status.cloud.google.com/' },
    { name: 'Cloudflare Status', url: 'https://www.cloudflarestatus.com/api/v2/status.json' },
    { name: 'Microsoft 365', url: 'https://status.cloud.microsoft/' },
    { name: 'DigitalOcean', url: 'https://status.digitalocean.com/' },
    { name: 'Fastly', url: 'https://status.fastly.com/' },
    { name: 'ServiceNow', url: 'https://status.servicenow.com/' },
    { name: 'Datto', url: 'https://status.datto.com/' },
    { name: 'Kaseya', url: 'https://status.kaseya.com/' },
    { name: 'ConnectWise', url: 'https://status.connectwise.com/' },
    { name: 'Zoom', url: 'https://status.zoom.us/' },
    { name: 'Slack', url: 'https://status.slack.com/' },
    { name: 'Okta', url: 'https://status.okta.com/' },
    { name: 'Veeam', url: 'https://status.veeam.com/' },
    { name: 'Toast POS', url: 'https://status.toasttab.com/' },
    { name: 'Agilysys', url: 'https://www.agilysys.com/status' },
    { name: 'SiteMinder', url: 'https://www.siteminder.com/status/' },
    { name: 'GoDaddy', url: 'https://www.godaddy.com/system-status' },
    { name: 'DownDetector Oracle', url: 'https://downdetector.com/status/oracle-cloud/' },
    { name: 'Datadog', url: 'https://status.datadoghq.com/' },
  ];
  const results = [];
  for (const ep of endpoints) {
    try {
      const start = Date.now();
      await fetchText(ep.url);
      const latency = Date.now() - start;
      results.push({ name: ep.name, status: 'reachable', latency, url: ep.url });
    } catch (err) {
      results.push({ name: ep.name, status: 'unreachable', error: err.message, url: ep.url });
    }
  }
  return results;
}

// ── Build geo data from status ────────────────────────────────────────────
function buildGeoData(services, downdetector, changes) {
  const points = [];
  const hotspots = [];
  const STATUS_WEIGHT = { major_outage: 5, outage: 4, degraded: 3, issues: 3, possible_issues: 2, warning: 2, operational: 0, good: 0, informational: 0 };

  // Map service status to geo points
  for (const [svcKey, svc] of Object.entries(services)) {
    if (svc.status === 'operational' || svc.status === 'good' || svc.status === 'informational') continue;
    const weight = STATUS_WEIGHT[svc.status] || 1;
    let geoLocations = [];

    // Direct OCI region mapping
    if (svcKey.startsWith('oci_')) {
      const region = svc.name?.toLowerCase() || '';
      for (const loc of GEO.oci) {
        if (region.includes(loc.name.split('(')[1]?.toLowerCase() || '\u0000')) geoLocations.push(loc);
      }
      if (geoLocations.length === 0) geoLocations = GEO.oci.slice(0, 5);
    }
    // Cloud providers
    else if (svcKey.startsWith('aws_'))  geoLocations = GEO.aws;
    else if (svcKey.startsWith('azure_')) geoLocations = GEO.azure;
    else if (svcKey.startsWith('cf_'))   geoLocations = GEO.cloudflare;
    else if (svcKey.startsWith('m365_')) geoLocations = GEO.azure;
    else if (svcKey.startsWith('gcp_'))  geoLocations = GEO.gcp;
    else if (svcKey.startsWith('do_'))   geoLocations = GEO.hosting.filter(l => l.id === 'host-do');
    else if (svcKey.startsWith('fastly_')) geoLocations = GEO.cdn.filter(l => l.provider === 'Fastly');
    else if (svcKey.startsWith('akamai_')) geoLocations = GEO.cdn.filter(l => l.provider === 'Akamai');
    // ITSM & RMM
    else if (svcKey.startsWith('cw_'))   geoLocations = GEO.rmm.filter(l => l.id === 'rmm-cw');
    else if (svcKey.startsWith('kaseya_')) geoLocations = GEO.rmm.filter(l => l.id.startsWith('rmm-kaseya'));
    else if (svcKey.startsWith('datto_')) geoLocations = GEO.rmm.filter(l => l.id.startsWith('rmm-datto')).concat(GEO.backup.filter(l => l.id.startsWith('bkp-datto')));
    else if (svcKey.startsWith('servicenow') || svcKey.includes('ServiceNow')) geoLocations = GEO.itsm.filter(l => l.id.startsWith('itsm-snow'));
    // Hospitality PMS & POS
    else if (svcKey.startsWith('pms_') || svcKey.includes('Opera')) geoLocations = GEO.pms.filter(l => l.id.startsWith('pms-opera'));
    else if (svcKey.includes('MICROS') || svcKey.includes('micros')) geoLocations = GEO.pos.filter(l => l.id.startsWith('pos-micros'));
    else if (svcKey.includes('Agilysys') || svcKey.includes('agilysys')) geoLocations = GEO.pms.filter(l => l.id === 'pms-agilysys');
    else if (svcKey.includes('Toast') || svcKey.includes('toast')) geoLocations = GEO.pos.filter(l => l.id.startsWith('pos-toast'));
    // Collaboration
    else if (svcKey.includes('Zoom') || svcKey.includes('zoom')) geoLocations = GEO.collaboration.filter(l => l.id === 'col-zoom');
    else if (svcKey.includes('Slack') || svcKey.includes('slack')) geoLocations = GEO.collaboration.filter(l => l.id === 'col-slack');
    // Backup
    else if (svcKey.startsWith('veeam') || svcKey.includes('Veeam')) geoLocations = GEO.backup.filter(l => l.id.startsWith('bkp-veeam'));
    // Payment
    else if (svcKey.includes('Visa') || svcKey.includes('visa')) geoLocations = GEO.payment.filter(l => l.id.startsWith('visa'));
    else if (svcKey.includes('Mastercard') || svcKey.includes('mastercard')) geoLocations = GEO.payment.filter(l => l.id.startsWith('mc'));
    else if (svcKey.includes('Stripe') || svcKey.includes('stripe')) geoLocations = GEO.payment.filter(l => l.id === 'stripe-us');
    else if (svcKey.includes('Square') || svcKey.includes('square')) geoLocations = GEO.pos.filter(l => l.id === 'pos-square');
    else if (svcKey.includes('Clover') || svcKey.includes('clover')) geoLocations = GEO.pos.filter(l => l.id === 'pos-clover');
    else if (svcKey.includes('Worldpay') || svcKey.includes('worldpay')) geoLocations = GEO.pos.filter(l => l.id === 'pos-worldpay');
    else if (svcKey.includes('Adyen') || svcKey.includes('adyen')) geoLocations = GEO.pos.filter(l => l.id === 'pos-adyen');
    else if (svcKey.includes('Okta') || svcKey.includes('okta')) geoLocations = GEO.idp.filter(l => l.id.startsWith('idp-okta'));
    else if (svcKey.includes('Datadog') || svcKey.includes('datadog')) geoLocations = GEO.monitoring.filter(l => l.id === 'mon-datadog');

    for (const loc of geoLocations) {
      points.push({
        id: `${svcKey}_${loc.id}`,
        lat: loc.lat,
        lng: loc.lng,
        size: Math.max(0.3, weight * 0.25),
        color: weight >= 4 ? '#ff0040' : weight >= 3 ? '#ff8800' : '#ffcc00',
        label: `${svc.name} \u2014 ${loc.name}`,
        weight
      });
    }
  }

  // DownDetector hotspot aggregation
  for (const dd of downdetector) {
    if (dd.status === 'operational' || dd.status === 'unknown') continue;
    const geoLocs = (dd.geoIds || []).map(id => GEO_INDEX[id]).filter(Boolean);
    if (geoLocs.length === 0) continue;
    const weight = dd.reports > 500 ? 4 : dd.reports > 100 ? 3 : dd.reports > 20 ? 2 : 1;
    for (const loc of geoLocs) {
      hotspots.push({
        id: `dd_${dd.name}_${loc.id}`,
        lat: loc.lat,
        lng: loc.lng,
        radius: weight * 4,
        color: dd.status === 'issues' ? 'rgba(255,0,64,0.35)' : 'rgba(255,200,0,0.25)',
        label: `${dd.name} (${dd.reports} reports) \u2014 ${loc.name}`,
        weight
      });
    }
  }

  // Status change arcs
  for (const ch of changes.slice(-10)) {
    if (ch.type !== 'new_issue' && ch.type !== 'status_change') continue;
    // Attempt to find a matching geo point from service name
    for (const loc of Object.values(GEO_INDEX)) {
      if (ch.service?.includes(loc.id) || ch.message?.toLowerCase().includes(loc.name.toLowerCase())) {
        points.push({
          id: `change_${ch.service}_${loc.id}`,
          lat: loc.lat,
          lng: loc.lng,
          size: 0.5,
          color: '#00ffff',
          label: ch.message,
          weight: 3,
          isChange: true
        });
      }
    }
  }

  // Always show all infrastructure points (grey, dim) for context
  for (const category of Object.values(GEO)) {
    for (const loc of category) {
      if (!points.find(p => p.lat === loc.lat && p.lng === loc.lng)) {
        points.push({
          id: `base_${loc.id}`,
          lat: loc.lat,
          lng: loc.lng,
          size: 0.15,
          color: '#446688',
          label: loc.name,
          weight: 0,
          provider: loc.provider
        });
      }
    }
  }

  return { points, hotspots };
}

// ── Refresh loop ──────────────────────────────────────────────────────────
async function refreshAllData() {
  console.log('Refreshing all data...');
  try {
    const previousState = loadPreviousState();
    const newState = {};

    const [oci, azure, cloudflare, aws, m365, gcp, doStatus, fastly, akamai, veeam, cw, kaseya, datto, agilysys,
           incidents, dd, rss, endpoints] = await Promise.all([
      fetchOCI(), fetchAzureStatus(), fetchCloudflareStatus(), fetchAWSStatus(), fetchM365Status(),
      fetchGCPStatus(), fetchDigitalOceanStatus(), fetchFastlyStatus(), fetchAkamaiStatus(),
      fetchVeeamStatus(), fetchConnectWiseStatus(), fetchKaseyaStatus(), fetchDattoStatus(), fetchAgilysysStatus(),
      fetchOCIRSS(), fetchDownDetectorServices(), fetchOracleRSS(), checkEndpoints()
    ]);

    Object.assign(newState, oci.services, azure.services, cloudflare.services, aws.services, m365.services,
      gcp.services, doStatus.services, fastly.services, akamai.services,
      veeam.services, cw.services, kaseya.services, datto.services, agilysys.services);
    for (const d of dd) { newState[`dd_${d.name}`] = { name: d.name, status: d.status, provider: 'DownDetector' }; }

    const changes = detectChanges(previousState, newState);
    saveCurrentState(newState);

    const geo = buildGeoData(newState, dd, [...changes, ...statusCache.changes]);

    statusCache = {
      services: newState,
      providers: {
        oci: { status: oci.status, description: oci.description },
        azure: { status: azure.services && Object.keys(azure.services).length ? 'checked' : 'unknown' },
        cloudflare: { status: cloudflare.status || 'unknown' },
        aws: { status: aws.services && Object.keys(aws.services).length ? 'checked' : 'unknown' },
        m365: { status: m365.services && Object.keys(m365.services).length ? 'checked' : 'unknown' },
        gcp: { status: gcp.services && Object.keys(gcp.services).length ? 'checked' : 'unknown' },
        digitalocean: { status: doStatus.services && Object.keys(doStatus.services).length ? 'checked' : 'unknown' },
        fastly: { status: fastly.services && Object.keys(fastly.services).length ? 'checked' : 'unknown' },
        akamai: { status: akamai.services && Object.keys(akamai.services).length ? 'checked' : 'unknown' },
        veeam: { status: veeam.services && Object.keys(veeam.services).length ? 'checked' : 'unknown' },
        connectwise: { status: cw.services && Object.keys(cw.services).length ? 'checked' : 'unknown' },
        kaseya: { status: kaseya.services && Object.keys(kaseya.services).length ? 'checked' : 'unknown' },
        datto: { status: datto.services && Object.keys(datto.services).length ? 'checked' : 'unknown' },
        agilysys: { status: agilysys.services && Object.keys(agilysys.services).length ? 'checked' : 'unknown' },
      },
      incidents,
      downdetector: dd,
      rss,
      endpoints,
      geo,
      changes: [...changes, ...statusCache.changes].slice(0, 50),
      lastUpdated: new Date().toISOString()
    };

    if (changes.length > 0) console.log(`Detected ${changes.length} changes:`, changes.map(c => c.message));
    else console.log('Data refreshed, no status changes.');
  } catch (err) { console.error('Refresh failed:', err.message); }
}

// ── Routes ────────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

app.get('/api/status',      (req, res) => res.json(statusCache));
app.get('/api/services',    (req, res) => res.json(statusCache.services || {}));
app.get('/api/incidents',   (req, res) => res.json(statusCache.incidents || []));
app.get('/api/downdetector',(req, res) => res.json(statusCache.downdetector || []));
app.get('/api/rss',         (req, res) => res.json(statusCache.rss || []));
app.get('/api/changes',     (req, res) => res.json(statusCache.changes || []));
app.get('/api/geo',         (req, res) => res.json(statusCache.geo || { points: [], hotspots: [] }));
app.get('/api/refresh',     async (req, res) => { await refreshAllData(); res.json({ ok: true, lastUpdated: statusCache.lastUpdated }); });
app.get('/api/health',      (req, res) => res.json({ status: 'ok', uptime: process.uptime(), lastUpdated: statusCache.lastUpdated }));

// ── Start ─────────────────────────────────────────────────────────────────
refreshAllData();
cron.schedule('*/2 * * * *', refreshAllData);
app.listen(PORT, '0.0.0.0', () => console.log(`Oracle Status Dashboard running on port ${PORT}`));
