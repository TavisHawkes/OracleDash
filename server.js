const express = require('express');
const https = require('https');
const http = require('http');
const { parseString } = require('xml2js');
const cron = require('node-cron');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Cache for status data
let statusCache = {
  oci: null,
  downdetector: null,
  rss: [],
  incidents: [],
  lastUpdated: null
};

// Fetch JSON from URL
function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, { timeout: 15000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`JSON parse error: ${e.message}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
  });
}

// Fetch XML from URL
function fetchXML(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, { timeout: 15000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        parseString(data, (err, result) => {
          if (err) reject(err);
          else resolve(result);
        });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
  });
}

// Fetch text content for scraping
function fetchText(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, { timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
  });
}

// Fetch OCI status from official API
async function fetchOCIStatus() {
  try {
    const [components, status] = await Promise.all([
      fetchJSON('https://ocistatus.oraclecloud.com/api/v2/components.json'),
      fetchJSON('https://ocistatus.oraclecloud.com/api/v2/status.json')
    ]);
    return { components, status, source: 'OCI Official', fetchedAt: new Date().toISOString() };
  } catch (err) {
    console.error('OCI status fetch failed:', err.message);
    return null;
  }
}

// Fetch OCI incidents RSS
async function fetchOCIIncidents() {
  try {
    const result = await fetchXML('https://ocistatus.oraclecloud.com/api/v2/incident-summary.rss');
    const items = result?.rss?.channel?.[0]?.item || [];
    return items.slice(0, 20).map(item => ({
      title: item.title?.[0] || '',
      description: item.description?.[0] || '',
      link: item.link?.[0] || '',
      pubDate: item.pubDate?.[0] || ''
    }));
  } catch (err) {
    console.error('OCI incidents RSS fetch failed:', err.message);
    return [];
  }
}

// Parse DownDetector page for Oracle Cloud reports
async function fetchDownDetector() {
  try {
    const html = await fetchText('https://downdetector.com/status/oracle-cloud/');
    const reportMatch = html.match(/(\d+)\s*reports/i);
    const reports = reportMatch ? parseInt(reportMatch[1]) : 0;

    let status = 'unknown';
    if (html.includes('No problems detected') || html.includes('no-current-problems')) {
      status = 'operational';
    } else if (html.includes('Problems detected') || html.includes('possible-problems')) {
      status = 'issues';
    }

    return {
      reports,
      status,
      source: 'DownDetector',
      fetchedAt: new Date().toISOString()
    };
  } catch (err) {
    console.error('DownDetector fetch failed:', err.message);
    return null;
  }
}

// Fetch Oracle RSS feeds
async function fetchOracleRSS() {
  const feeds = [
    'https://www.oracle.com/rss/feeds/cloud-news.xml',
    'https://blogs.oracle.com/cloud-infrastructure/rss'
  ];
  const allItems = [];

  for (const feed of feeds) {
    try {
      const result = await fetchXML(feed);
      const items = result?.rss?.channel?.[0]?.item || [];
      allItems.push(...items.slice(0, 10).map(item => ({
        title: item.title?.[0] || '',
        description: item.description?.[0] || '',
        link: item.link?.[0] || '',
        pubDate: item.pubDate?.[0] || '',
        source: 'Oracle News'
      })));
    } catch (err) {
      console.error(`RSS feed ${feed} failed:`, err.message);
    }
  }

  // Also fetch OCI incident history RSS
  try {
    const result = await fetchXML('https://ocistatus.oraclecloud.com/api/v2/incident-summary.rss');
    const items = result?.rss?.channel?.[0]?.item || [];
    allItems.push(...items.slice(0, 10).map(item => ({
      title: item.title?.[0] || '',
      description: item.description?.[0] || '',
      link: item.link?.[0] || '',
      pubDate: item.pubDate?.[0] || '',
      source: 'OCI Incidents'
    })));
  } catch (err) {
    console.error('OCI RSS failed:', err.message);
  }

  return allItems.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
}

// Check additional Oracle service endpoints
async function checkAdditionalEndpoints() {
  const endpoints = [
    { name: 'Oracle Cloud Infrastructure', url: 'https://ocistatus.oraclecloud.com/api/v2/status.json' },
    { name: 'Oracle Hospitality (OPERA)', url: 'https://www.oracle.com/hospitality/' },
    { name: 'Oracle Java', url: 'https://www.oracle.com/java/' },
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

// Master refresh function
async function refreshAllData() {
  console.log('Refreshing dashboard data...');
  try {
    const [oci, incidents, downdetector, rss, endpoints] = await Promise.all([
      fetchOCIStatus(),
      fetchOCIIncidents(),
      fetchDownDetector(),
      fetchOracleRSS(),
      checkAdditionalEndpoints()
    ]);

    statusCache = {
      oci,
      incidents,
      downdetector,
      rss,
      endpoints,
      lastUpdated: new Date().toISOString()
    };

    console.log('Dashboard data refreshed at', statusCache.lastUpdated);
  } catch (err) {
    console.error('Refresh failed:', err.message);
  }
}

// API routes
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/status', (req, res) => {
  res.json(statusCache);
});

app.get('/api/oci', (req, res) => {
  res.json(statusCache.oci || { error: 'Not yet loaded' });
});

app.get('/api/incidents', (req, res) => {
  res.json(statusCache.incidents || []);
});

app.get('/api/downdetector', (req, res) => {
  res.json(statusCache.downdetector || { error: 'Not yet loaded' });
});

app.get('/api/rss', (req, res) => {
  res.json(statusCache.rss || []);
});

app.get('/api/refresh', async (req, res) => {
  await refreshAllData();
  res.json({ success: true, lastUpdated: statusCache.lastUpdated });
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// Initial load and cron schedule
refreshAllData();
cron.schedule('*/3 * * * *', refreshAllData); // Every 3 minutes

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Oracle Status Dashboard running on port ${PORT}`);
});
