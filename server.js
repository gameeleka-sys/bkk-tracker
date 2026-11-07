const express = require('express');
const cors = require('cors');
const https = require('https');
const GtfsRealtimeBindings = require('gtfs-realtime-bindings');
const fs = require('fs');
const csv = require('csv-parser');
const admin = require('firebase-admin');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3333;
const BKK_API_KEY = '204dc94e-0379-4403-af32-888232066de5';

// Enable CORS and JSON body parsing
app.use(cors());
app.use(express.json());

// Initialize Firebase Admin
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
    projectId: 'budapestradar26'
  });
}

const routeDetailsMap = new Map();

// Helper function to customize line name display
function getDisplayLine(routeNumber) {
  const line = String(routeNumber).trim();
  
  if (line === '100E' || line.includes('100E')) {
    return 'AIRPORT EXPRESS';
  }
  
  if (line === '0075' || line.includes('0075')) {
    return '7E';
  }
  
  if (!line || line === 'Transit') {
    return 'Transit'; 
  }

  return line;
}

// Helper function to guess vehicle model based on plate prefix
function getVehicleModel(licensePlate) {
  if (!licensePlate || licensePlate === 'N/A') return 'Unknown Model';
  const plate = licensePlate.toUpperCase();

  if (plate.startsWith('NCG') || plate.startsWith('MZE') || plate.startsWith('PHC') || plate.startsWith('PDN')) {
    return 'Mercedes-Benz Conecto';
  } else if (plate.startsWith('SEF') || plate.startsWith('MHU')) {
    return 'MAN / Volvo Hybrid';
  } else if (plate.startsWith('20-') || plate.startsWith('30-')) {
    return 'CAF Urbos Tram';
  }
  return 'BKK Transit Fleet';
}

async function loadStaticRoutes() {
  console.log('Loading routes.txt...');
  return new Promise((resolve) => {
    if (!fs.existsSync('routes.txt')) return resolve();
    fs.createReadStream('routes.txt')
      .pipe(csv())
      .on('data', (row) => {
        if (row.route_id) {
          routeDetailsMap.set(row.route_id, {
            shortName: row.route_short_name || row.route_id,
            type: parseInt(row.route_type, 10)
          });
        }
      })
      .on('end', () => {
        console.log(`Loaded ${routeDetailsMap.size} route mappings.`);
        resolve();
      });
  });
}

// Serve static files from root and handle index.html route explicitly
app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

function fetchBuffer(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

// Admin API: List all users
app.get('/api/admin/users', async (req, res) => {
  try {
    const listUsersResult = await admin.auth().listUsers(1000);
    const users = listUsersResult.users.map(userRecord => ({
      uid: userRecord.uid,
      email: userRecord.email,
      disabled: userRecord.disabled,
      isAdmin: !!userRecord.customClaims?.admin
    }));
    res.json(users);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Admin API: Create a user
app.post('/api/admin/create-user', async (req, res) => {
  try {
    const { email, password, makeAdmin } = req.body;
    const userRecord = await admin.auth().createUser({ email, password });

    if (makeAdmin) {
      await admin.auth().setCustomUserClaims(userRecord.uid, { admin: true });
    }

    res.json({ success: true, uid: userRecord.uid });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Admin API: Modify user role or status
app.post('/api/admin/modify-user', async (req, res) => {
  try {
    const { uid, makeAdmin, disabled } = req.body;
    
    if (typeof makeAdmin === 'boolean') {
      await admin.auth().setCustomUserClaims(uid, { admin: makeAdmin });
    }
    
    if (typeof disabled === 'boolean') {
      await admin.auth().updateUser(uid, { disabled: disabled });
    }

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/buses', async (req, res) => {
  try {
    const url = `https://go.bkk.hu/api/query/v1/ws/gtfs-rt/full/VehiclePositions.pb?key=${BKK_API_KEY}`;
    const buffer = await fetchBuffer(url);
    const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(buffer);

    const activeVehicles = [];

    feed.entity.forEach((entity) => {
      if (!entity.vehicle || !entity.vehicle.position) return;

      const v = entity.vehicle;
      const rawRouteId = v.trip?.routeId || '';
      const routeInfo = routeDetailsMap.get(rawRouteId) || { shortName: rawRouteId.replace(/[\[\]]/g, ''), type: 3 };

      let rawLabel = v.vehicle?.label || '';
      let rawPlate = v.vehicle?.licensePlate || '';

      if (!rawPlate) {
        if (v.vehicle?.id) {
          rawPlate = v.vehicle.id;
        } else if (entity.id) {
          rawPlate = entity.id;
        } else if (rawLabel) {
          const match = rawLabel.match(/\[(.*?)\]/);
          if (match && match[1]) {
            rawPlate = match[1];
          }
        }
      }

      let cleanPlate = String(rawPlate).replace(/[\[\]]/g, '').trim() || 'N/A';
      let cleanRoute = String(routeInfo.shortName || rawRouteId).replace(/[\[\]]/g, '').trim() || 'N/A';
      let cleanDest = rawLabel.replace(/\[.*?\]/g, '').replace(/[\[\]]/g, '').trim() || 'In Service';

      let vehicleType = 'bus';
      if (routeInfo.type === 0 || cleanRoute === '4' || cleanRoute === '6') vehicleType = 'tram';
      else if (routeInfo.type === 11 || (Number(cleanRoute) >= 70 && Number(cleanRoute) <= 83)) vehicleType = 'trolley';

      activeVehicles.push({
        id: String(entity.id || v.vehicle?.id || Math.random()),
        routeNumber: getDisplayLine(cleanRoute),
        destination: cleanDest,
        licensePlate: cleanPlate,
        vehicleModel: getVehicleModel(cleanPlate),
        vehicleType: vehicleType,
        latitude: v.position.latitude,
        longitude: v.position.longitude
      });
    });

    res.json(activeVehicles);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

loadStaticRoutes().then(() => {
  app.listen(PORT, () => console.log(`Server active on port ${PORT}`));
});
