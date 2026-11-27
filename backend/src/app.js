const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const env = require('./config/env');
const AppError = require('./utils/AppError');
const authRoutes = require('./auth/auth.controller');
const orgRoutes = require('./organizations/org.controller');
const invitationRoutes = require('./invitations/invitation.controller');
const documentRoutes = require('./documents/document.controller');
const ragRoutes = require('./rag/rag.controller');
const conversationRoutes = require('./conversations/conversation.controller');
const authMiddleware = require('./middleware/auth');
const tenantMiddleware = require('./middleware/tenant');
const rateLimiter = require('./middleware/rate-limiter');
const { createErrorHandler, developmentDiagnosticsEnabled } = require('./middleware/error-handler');
const { requestContext, tagRoute, httpMetrics, metricsHandler } = require('./observability/http');
const { createHealthRouter } = require('./observability/health');

const app = express();

// Behind Nginx (production) req.ip must come from X-Forwarded-For, limited to the configured
// number of trusted hops so clients cannot spoof their address to evade rate limits.
app.set('trust proxy', env.TRUST_PROXY);

// Correlation ID (X-Request-Id) + async log context, then request metrics / access log.
// Registered first so every request — including CORS preflights and 404s — is observed.
app.use(requestContext);
app.use(httpMetrics);

// Security Headers Middleware
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  next();
});

// CORS Configuration
app.use(cors({
  // Comma-separated allow-list (never '*' in production; enforced in config/env.js)
  origin: env.CORS_ORIGIN.includes(',') ? env.CORS_ORIGIN.split(',').map(o => o.trim()) : env.CORS_ORIGIN,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Organization-Id', 'X-Tenant-Id', 'X-Request-Id', 'Idempotency-Key'],
}));

app.use(express.json({ limit: '1mb' }));
app.use(cookieParser(env.COOKIE_SECRET));

// Health: GET /health (Step 4 contract), /health/live, /health/ready
app.use('/health', tagRoute, createHealthRouter());

// Prometheus scrape endpoint (token or private-network only; see observability/http.js)
app.get('/metrics', metricsHandler);

const ragRateLimiter = rateLimiter({
  windowMs: 60 * 1000,
  max: 60,
  keyGenerator: (req) => `ratelimit:rag:${req.tenantId || req.ip}:${req.baseUrl || ''}${req.path}`,
});

// Routes
// (tagRoute only records the mount path for low-cardinality metric labels)
app.use('/api/auth', tagRoute, authRoutes);
app.use('/api/organizations', tagRoute, authMiddleware, orgRoutes);
app.use('/api/invitations', tagRoute, authMiddleware, invitationRoutes);
app.use('/api/documents', tagRoute, authMiddleware, tenantMiddleware, documentRoutes);
app.use('/api/rag', tagRoute, authMiddleware, tenantMiddleware, ragRateLimiter, ragRoutes);
app.use('/api/conversations', tagRoute, authMiddleware, tenantMiddleware, conversationRoutes);

// Protected Tenant Test Endpoint (Step 4 Requirement: GET /api/test/tenant) — diagnostics only,
// never mounted in production.
if (env.NODE_ENV !== 'production') app.get('/api/test/tenant', authMiddleware, tenantMiddleware, (req, res) => {
  res.status(200).json({
    status: 'success',
    data: {
      user: {
        id: req.user.id,
        email: req.user.email,
        fullName: req.user.full_name,
      },
      tenantId: res.locals.tenantId,
      role: res.locals.userRole,
    },
  });
});

// 404 Handler — path only: the query string (e.g. ?token=…) is never reflected to the client
app.use((req, res, next) => {
  next(new AppError(`Can't find ${req.path} on this server!`, 404));
});

// Centralized Error Handler (src/middleware/error-handler.js). Detailed diagnostics only when
// the process environment explicitly sets NODE_ENV=development (read after env.js loaded
// .env) — never from the NODE_ENV default, and never from anything in a request.
app.use(createErrorHandler({ developmentDiagnostics: developmentDiagnosticsEnabled(process.env.NODE_ENV) }));

module.exports = app;

