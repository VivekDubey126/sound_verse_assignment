const express = require('express');
const cors = require('cors');
const path = require('path');
const { requestIdMiddleware } = require('./middleware/requestId');
const { errorHandler } = require('./middleware/errorHandler');
const { authRouter } = require('./routes/auth');
const { v1Router } = require('./routes/v1');
const { dashboardRouter } = require('./routes/dashboard');

function createApp() {
  const app = express();

  app.use(cors());
  app.use(express.json());
  app.use(requestIdMiddleware);

  // Serve developer dashboard UI
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // Expose OpenAPI Specification and Documentation endpoints
  app.get('/openapi.yaml', (_req, res) => {
    res.setHeader('Content-Type', 'text/yaml; charset=utf-8');
    res.sendFile(path.resolve(__dirname, '..', 'openapi.yaml'));
  });

  app.get('/quickstart', (_req, res) => {
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.sendFile(path.resolve(__dirname, '..', 'QUICKSTART.md'));
  });

  // Interactive Swagger UI documentation
  app.get('/docs', (_req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Soundverse Enterprise API — OpenAPI Interactive Docs</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5.11.0/swagger-ui.css" />
  <style>
    body { margin: 0; background: #0b0f19; }
    .swagger-ui { filter: invert(88%) hue-rotate(180deg); }
    .swagger-ui .topbar { display: none; }
  </style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5.11.0/swagger-ui-bundle.js" crossorigin></script>
  <script>
    window.onload = () => {
      window.ui = SwaggerUIBundle({
        url: '/openapi.yaml',
        dom_id: '#swagger-ui',
        deepLinking: true,
        presets: [
          SwaggerUIBundle.presets.apis,
          SwaggerUIBundle.SwaggerUIStandalonePreset
        ],
        layout: "BaseLayout"
      });
    };
  </script>
</body>
</html>
    `);
  });

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'Soundverse Enterprise API', time: new Date().toISOString() });
  });

  app.use('/auth', authRouter);
  app.use('/v1', v1Router);
  app.use('/dashboard', dashboardRouter);

  app.use((req, res) => {
    res.status(404).json({
      error: {
        type: 'not_found_error',
        code: 'route_not_found',
        message: 'Endpoint does not exist',
        request_id: req.requestId || 'unknown',
      },
    });
  });

  app.use(errorHandler);

  return app;
}

module.exports = { createApp };

