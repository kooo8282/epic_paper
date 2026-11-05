/// <reference types="@cloudflare/workers-types" />

interface Env {
  SCOPUS_API_KEY?: string;
}

export const onRequest: PagesFunction<Env> = async (context) => {
  const { request, env } = context;

  // Handle CORS Preflight / Method Check
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Accept',
      },
    });
  }

  if (request.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method Not Allowed' }), {
      status: 405,
      headers: {
        'Content-Type': 'application/json',
        'Allow': 'GET, OPTIONS',
      },
    });
  }

  // 1. Verify Cloudflare Secret configuration
  const apiKey = env.SCOPUS_API_KEY?.trim();
  if (!apiKey) {
    return new Response(
      JSON.stringify({
        error: 'SCOPUS_API_KEY secret is not configured on Cloudflare Pages. Please set SCOPUS_API_KEY in your Cloudflare Pages project settings.',
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  try {
    const url = new URL(request.url);
    const searchParams = url.searchParams;

    // 2. Validate and restrict query parameters
    const query = searchParams.get('query');
    if (!query || typeof query !== 'string' || !query.trim()) {
      return new Response(JSON.stringify({ error: 'Missing required "query" parameter' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Input length limit check
    if (query.length > 2000) {
      return new Response(JSON.stringify({ error: 'Query exceeds maximum allowed length of 2000 characters' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Build upstream URL with allowed parameters only
    const upstreamUrl = new URL('https://api.elsevier.com/content/search/scopus');
    upstreamUrl.searchParams.set('query', query.trim());

    // count (default 25, max 25 as per Scopus API limits)
    const countParam = searchParams.get('count');
    if (countParam) {
      const parsedCount = parseInt(countParam, 10);
      if (!isNaN(parsedCount) && parsedCount > 0 && parsedCount <= 25) {
        upstreamUrl.searchParams.set('count', String(parsedCount));
      } else {
        upstreamUrl.searchParams.set('count', '25');
      }
    } else {
      upstreamUrl.searchParams.set('count', '25');
    }

    // start (pagination offset, default 0, max 5000)
    const startParam = searchParams.get('start');
    if (startParam) {
      const parsedStart = parseInt(startParam, 10);
      if (!isNaN(parsedStart) && parsedStart >= 0 && parsedStart <= 5000) {
        upstreamUrl.searchParams.set('start', String(parsedStart));
      } else {
        upstreamUrl.searchParams.set('start', '0');
      }
    } else {
      upstreamUrl.searchParams.set('start', '0');
    }

    // view (support COMPLETE or STANDARD)
    const viewParam = searchParams.get('view');
    if (viewParam === 'COMPLETE') {
      upstreamUrl.searchParams.set('view', 'COMPLETE');
    } else if (viewParam === 'STANDARD') {
      upstreamUrl.searchParams.set('view', 'STANDARD');
    }

    // 3. Forward request to Elsevier Scopus API with timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000); // 15 second timeout

    let upstreamResponse: Response;
    try {
      upstreamResponse = await fetch(upstreamUrl.toString(), {
        method: 'GET',
        headers: {
          'X-ELS-APIKey': apiKey,
          'Accept': 'application/json',
          'User-Agent': 'EPIC-Paper-Cloudflare-Function/1.0',
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    // 4. Handle upstream error responses cleanly without exposing sensitive headers or credentials
    if (!upstreamResponse.ok) {
      let safeErrorDetail = `Upstream Scopus API error (${upstreamResponse.status})`;
      try {
        const errJson: any = await upstreamResponse.json();
        const msg =
          errJson?.['service-error']?.status?.statusText ||
          errJson?.['error-response']?.['error-message'] ||
          errJson?.message;
        if (msg && typeof msg === 'string') {
          safeErrorDetail = msg;
        }
      } catch {
        safeErrorDetail = upstreamResponse.statusText || safeErrorDetail;
      }

      return new Response(
        JSON.stringify({
          error: safeErrorDetail,
          status: upstreamResponse.status,
        }),
        {
          status: upstreamResponse.status,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          },
        }
      );
    }

    // 5. Return JSON payload to client
    const data = await upstreamResponse.text();
    return new Response(data, {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (err: any) {
    const isTimeout = err?.name === 'AbortError';
    const message = isTimeout
      ? 'Scopus API request timed out (15s).'
      : 'Internal error processing Scopus request.';

    return new Response(
      JSON.stringify({
        error: message,
      }),
      {
        status: isTimeout ? 504 : 500,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      }
    );
  }
};
