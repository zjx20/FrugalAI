import { Hono } from 'hono';
import { SignJWT, jwtVerify } from 'jose';
import { Database } from './core/db';
import { ProviderName, PrismaClient, ThrottleMode } from './generated/prisma';
import { PrismaD1 } from '@prisma/adapter-d1';

const admin = new Hono<{ Bindings: { DB: D1Database; ADMIN_PASSWORD_HASH: string; JWT_SECRET: string } }>();

/**
 * JWT auth middleware
 */
const adminAuth = async (c: any, next: any) => {
  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const token = authHeader.substring(7);
  try {
    const secret = new TextEncoder().encode(c.env.JWT_SECRET);
    const { payload } = await jwtVerify(token, secret);
    if (!(payload as any).admin) {
      return c.json({ error: 'Invalid token payload' }, 401);
    }
    await next();
  } catch (error) {
    return c.json({ error: 'Invalid or expired token' }, 401);
  }
};

/**
 * Admin login
 */
admin.post('/login', async (c) => {
  try {
    const { password } = await c.req.json();

    if (!password) {
      return c.json({ error: 'Password is required' }, 400);
    }

    // Verify password hash
    const encoder = new TextEncoder();
    const data = encoder.encode(password);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

    if (hashHex !== c.env.ADMIN_PASSWORD_HASH) {
      return c.json({ error: 'Invalid password' }, 401);
    }

    // Generate JWT (valid for 24 hours)
    const secret = new TextEncoder().encode(c.env.JWT_SECRET);
    const token = await new SignJWT({ admin: true })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('24h')
      .sign(secret);

    return c.json({ token });
  } catch (error) {
    console.error('Admin login error:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

/**
 * Get all provider configurations
 */
admin.get('/providers', adminAuth, async (c) => {
  try {
    const adapter = new PrismaD1(c.env.DB);
    const prisma = new PrismaClient({ adapter });
    const db = new Database(prisma);
    const providers = await db.getAllProviders();
    return c.json(providers);
  } catch (error) {
    console.error('Get providers error:', error);
    return c.json({ error: 'Failed to fetch providers' }, 500);
  }
});

/**
 * Update provider configuration
 */
admin.put('/providers/:name', adminAuth, async (c) => {
  try {
    const name = c.req.param('name') as ProviderName;
    const data = await c.req.json();

    // Validate provider name
    if (!(name in ProviderName)) {
      return c.json({ error: 'Invalid provider name' }, 400);
    }

    // Validate payload
    if (data.throttleMode && !(data.throttleMode in ThrottleMode)) {
      return c.json({ error: 'Invalid throttle mode' }, 400);
    }

    if (data.minThrottleDuration !== undefined && (typeof data.minThrottleDuration !== 'number' || data.minThrottleDuration < 0)) {
      return c.json({ error: 'Invalid minThrottleDuration' }, 400);
    }

    if (data.maxThrottleDuration !== undefined && (typeof data.maxThrottleDuration !== 'number' || data.maxThrottleDuration < 0)) {
      return c.json({ error: 'Invalid maxThrottleDuration' }, 400);
    }

    if (data.models && !Array.isArray(data.models)) {
      return c.json({ error: 'Models must be an array' }, 400);
    }

    const adapter = new PrismaD1(c.env.DB);
    const prisma = new PrismaClient({ adapter });
    const db = new Database(prisma);
    const updatedProvider = await db.updateProvider(name, {
      throttleMode: data.throttleMode,
      minThrottleDuration: data.minThrottleDuration,
      maxThrottleDuration: data.maxThrottleDuration,
      models: data.models,
    });

    return c.json(updatedProvider);
  } catch (error) {
    console.error('Update provider error:', error);
    return c.json({ error: 'Failed to update provider' }, 500);
  }
});

export default admin;
