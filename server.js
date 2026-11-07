// Add firebase-admin requirement at the top of server.js if not already present
const admin = require('firebase-admin');

// Ensure you have initialized firebase-admin with your service account credentials
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.applicationDefault() // or your service account key path
  });
}

// Endpoint to list all users and their admin claims/status
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

// Endpoint to create a user (with optional admin promotion)
app.post('/api/admin/create-user', async (req, res) => {
  try {
    const { email, password, makeAdmin } = req.body;
    const userRecord = await admin.auth().createUser({
      email,
      password,
    });

    if (makeAdmin) {
      await admin.auth().setCustomUserClaims(userRecord.uid, { admin: true });
    }

    res.json({ success: true, uid: userRecord.uid });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Endpoint to modify user role or disable account
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
