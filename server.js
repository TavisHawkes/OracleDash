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

async function fetchOCIRSS() {
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
    { name: 'Oracle Cloud', slug: 'oracle-cloud', geoIds: ['oc-us-ashburn', 'oc-eu-frankfurt', 'oc-ap-tokyo'] },
    { name: 'Oracle Hospitality/Opera', slug: 'oracle-hospitality', geoIds: ['h-marriott', 'h-hilton', 'h-ihg'] },
    { name: 'AWS', slug: 'amazon-web-services-aws', geoIds: ['aws-va', 'aws-or', 'aws-ie'] },
    { name: 'Azure', slug: 'microsoft-azure', geoIds: ['az-va', 'az-nl', 'az-uk'] },
    { name: 'Cloudflare', slug: 'cloudflare', geoIds: ['cf-nyc', 'cf-lon', 'cf-tok'] },
    { name: 'Microsoft 365', slug: 'microsoft-office-365', geoIds: ['az-va'] },
    { name: 'Visa', slug: 'visa', geoIds: ['visa-us', 'visa-eu'] },
    { name: 'Mastercard', slug: 'mastercard', geoIds: ['mc-us', 'mc-eu'] },
    { name: 'Stripe', slug: 'stripe', geoIds: ['stripe-us'] },
    { name: 'ServiceNow', slug: 'servicenow', geoIds: ['fin-nyc'] },
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
    { name: 'Azure Status', url: 'https://azure.status.microsoft/' },
    { name: 'AWS Status', url: 'https://health.aws.amazon.com/health/status' },
    { name: 'Cloudflare Status', url: 'https://www.cloudflarestatus.com/api/v2/status.json' },
    { name: 'Microsoft 365', url: 'https://status.cloud.microsoft/' },
    { name: 'DownDetector Oracle', url: 'https://downdetector.com/status/oracle-cloud/' },
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
      // Generic OCI service issues show all regions
      if (geoLocations.length === 0) geoLocations = GEO.oci.slice(0, 5);
    }
    // Provider-specific mapping
    else if (svcKey.startsWith('aws_'))  geoLocations = GEO.aws;
    else if (svcKey.startsWith('azure_')) geoLocations = GEO.azure;
    else if (svcKey.startsWith('cf_'))   geoLocations = GEO.cloudflare;
    else if (svcKey.startsWith('m365_')) geoLocations = GEO.azure; // M365 runs on Azure

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

    const [oci, azure, cloudflare, aws, m365, incidents, dd, rss, endpoints] = await Promise.all([
      fetchOCI(), fetchAzureStatus(), fetchCloudflareStatus(), fetchAWSStatus(), fetchM365Status(),
      fetchOCIRSS(), fetchDownDetectorServices(), fetchOracleRSS(), checkEndpoints()
    ]);

    Object.assign(newState, oci.services, azure.services, cloudflare.services, aws.services, m365.services);
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
