import express, { type Express, type Request, type Response } from 'express'

const app: Express = express();

// Disable x-powered-by header
app.disable('x-powered-by');

// Health check endpoint
app.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
  });
});

// Default route - shows which backend handled the request
app.use((req: Request, res: Response) => {
  res.json({
    message: `Hello!`,
    backend: {
    },
    request: {
      method: req.method,
      path: req.path,
      headers: {
        host: req.get('host'),
        'x-forwarded-for': req.get('x-forwarded-for'),
      },
    },
    timestamp: new Date().toISOString(),
  });
});

export {
  app
}
