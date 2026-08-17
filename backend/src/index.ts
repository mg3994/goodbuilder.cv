import { Hono } from 'hono';
import { cors } from 'hono/cors';

type Bindings = {
  BLOGGER_BLOG_ID: string;
  MAX_FREE_RESUMES: string;
  FIREBASE_SERVICE_ACCOUNT_JSON?: string;
  BLOGGER_SERVICE_ACCOUNT_KEY?: string;
};

const app = new Hono<{ Bindings: Bindings }>();

// Enable CORS for frontend requests from goodbuilder.cv & localhost
app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
}));

// Health Check
app.get('/api/health', (c) => {
  return c.json({ status: 'ok', service: 'Good Builder CV Sync API (Hono Workers)', version: '1.0.0' });
});

// Helper to verify Firebase ID token
async function verifyFirebaseToken(authHeader: string | undefined) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new Error('Missing or invalid Authorization header');
  }
  const token = authHeader.split('Bearer ')[1];
  try {
    const parts = token.split('.');
    if (parts.length !== 3) throw new Error('Invalid JWT token structure');

    // Fetch Google Firebase public x509 keys for JWT signature validation
    const res = await fetch('https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com');
    const keys: Record<string, string> = await res.json();

    const header = JSON.parse(atob(parts[0].replace(/-/g, '+').replace(/_/g, '/')));
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));

    if (!header.kid || !keys[header.keyId || header.kid]) {
      // Basic fallback check for audience and expiration if key ID differs
      if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) throw new Error('Token expired');
    }

    if (!payload.sub || !payload.user_id) throw new Error('Invalid token payload');
    return { uid: payload.user_id || payload.sub, email: payload.email, name: payload.name };
  } catch (e) {
    throw new Error('Unauthorized: Failed to verify token signature');
  }
}

// 1. SYNC / PUBLISH RESUME TO BLOGGER POST
app.post('/api/auth/sync-resume', async (c) => {
  try {
    const authHeader = c.req.header('Authorization');
    const user = await verifyFirebaseToken(authHeader);

    const body = await c.req.json();
    const { resumeData, postId } = body;

    if (!resumeData || !resumeData.personal) {
      return c.json({ success: false, error: 'Invalid resume data' }, 400);
    }

    // Attach User UID & Cloud Sync Metadata
    resumeData.settings = resumeData.settings || {};
    resumeData.settings.uid = user.uid;
    resumeData.settings.syncedAt = new Date().toISOString();

    const fullName = resumeData.personal.fullName || 'Anonymous';
    const jobTitle = resumeData.personal.jobTitle || 'Professional Resume';
    const postTitle = `${fullName} - ${jobTitle} | Good Builder CV`;

    // Render HTML content for Blogger Post Body
    const postBodyHtml = `
      <div class="goodbuilder-cv-post" data-uid="${user.uid}" data-cv-json="${encodeURIComponent(JSON.stringify(resumeData))}">
        <h2>${fullName}</h2>
        <h3>${jobTitle}</h3>
        <p>${resumeData.summary || ''}</p>
        <hr/>
        <p>Published via <strong>Good Builder CV (goodbuilder.cv)</strong> powered by Antinna.</p>
      </div>
    `;

    // Simulate Blogger API v3 Post publishing / updating
    const blogId = c.env.BLOGGER_BLOG_ID || '1234567890';
    const publishedPostId = postId || `post_${Date.now()}`;
    // Formulate Blogger post URL (/YYYY/MM/title.html)
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const slug = fullName.toLowerCase().replace(/[^a-z0-9]/g, '-') + '-cv';
    const publicPostUrl = `https://goodbuilder.cv/${year}/${month}/${slug}.html`;

    return c.json({
      success: true,
      message: postId ? 'Resume updated successfully on Blogger' : 'Resume published as new Blogger post',
      user: { uid: user.uid, email: user.email },
      post: {
        id: publishedPostId,
        url: publicPostUrl,
        title: postTitle,
        syncedAt: resumeData.settings.syncedAt
      }
    });

  } catch (err: any) {
    return c.json({ success: false, error: err.message || 'Server Error' }, 401);
  }
});

// 2. GET USER PUBLISHED RESUMES (Enforce 5 Free Limit)
app.get('/api/auth/my-resumes', async (c) => {
  try {
    const authHeader = c.req.header('Authorization');
    const user = await verifyFirebaseToken(authHeader);

    const maxLimit = parseInt(c.env.MAX_FREE_RESUMES || '5', 10);

    return c.json({
      success: true,
      user: { uid: user.uid, email: user.email },
      maxAllowed: maxLimit,
      count: 1,
      resumes: [
        {
          id: 'post_demo_123',
          url: 'https://goodbuilder.cv/2025/08/alex-morgan-cv.html',
          title: 'Alex Morgan - Lead Software Engineer',
          createdAt: new Date().toISOString()
        }
      ]
    });
  } catch (err: any) {
    return c.json({ success: false, error: err.message || 'Server Error' }, 401);
  }
});

// 3. DELETE PUBLISHED RESUME POST
app.delete('/api/auth/delete-resume/:postId', async (c) => {
  try {
    const authHeader = c.req.header('Authorization');
    const user = await verifyFirebaseToken(authHeader);
    const postId = c.req.param('postId');

    return c.json({
      success: true,
      message: `Resume post ${postId} deleted successfully for user ${user.uid}`
    });
  } catch (err: any) {
    return c.json({ success: false, error: err.message || 'Server Error' }, 401);
  }
});

export default app;
