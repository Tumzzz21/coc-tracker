require('dotenv').config();

const path = require('path');
const express = require('express');
const pool = require('./config/db');
const authRoutes = require('./routes/auth');
const memberRoutes = require('./routes/members');
const warRoutes = require('./routes/wars');
const sessionRoutes = require('./routes/sessions');
const { requireAuth } = authRoutes;

const app = express();
const port = Number(process.env.PORT || 3000);

app.use(express.json({ limit: '32kb' }));
app.use(express.urlencoded({ extended: false }));

app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/auth', authRoutes.router);
app.use('/api/members', memberRoutes);
app.use('/api', warRoutes);
app.use('/api/sessions', sessionRoutes);

app.get('/api/settings', async (req, res, next) => {
  try {
    const [rows] = await pool.execute('SELECT bg_image_url AS bgImageUrl FROM settings WHERE id = 1');
    res.json({ data: rows[0] || { bgImageUrl: null } });
  } catch (error) {
    next(error);
  }
});

app.put('/api/settings', requireAuth, async (req, res, next) => {
  const value = req.body && req.body.bgImageUrl;
  if (value !== null && value !== '' && (typeof value !== 'string' || value.length > 2048)) {
    return res.status(400).json({ error: 'bgImageUrl must be a URL no longer than 2048 characters, or null.' });
  }

  if (value && !/^https?:\/\/\S+$/i.test(value)) {
    return res.status(400).json({ error: 'bgImageUrl must use http or https.' });
  }

  try {
    await pool.execute(
      'INSERT INTO settings (id, bg_image_url) VALUES (1, ?) ON DUPLICATE KEY UPDATE bg_image_url = VALUES(bg_image_url)',
      [value || null]
    );
    res.json({ data: { bgImageUrl: value || null } });
  } catch (error) {
    next(error);
  }
});

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'API endpoint not found.' });
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'), (error) => {
    if (error) next(error);
  });
});

app.use((error, req, res, next) => {
  // Keep database details out of responses while preserving a useful server log.
  console.error(error);
  if (res.headersSent) return next(error);
  if (error && error.code === 'ER_NO_SUCH_TABLE') {
    error.statusCode = 503;
    error.publicMessage = 'Session database tables are missing. Restart the server to initialize them.';
  }
  res.status(error.statusCode || 500).json({
    error: error.publicMessage || (error.statusCode ? error.message : 'An unexpected server error occurred.')
  });
});

async function startServer() {
  try {
    await sessionRoutes.initializeSessionTables();
    app.listen(port, () => {
      console.log(`Clan tracker listening on port ${port}`);
    });
  } catch (error) {
    console.error('Unable to initialize session tables before startup.', error);
    process.exitCode = 1;
  }
}

if (require.main === module) startServer();

module.exports = app;
