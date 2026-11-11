import { signMetadata } from './signing.mjs';
/** CPU-light relay. Kubernetes owns MIME parsing, DKIM and attachment storage. */
const MAX_RAW_BYTES = 10 * 1024 * 1024;
export default {
  async email(message, env) {
    const origin = new URL(env.API_ORIGIN);
    if (
      origin.protocol !== 'https:' ||
      origin.username ||
      origin.password ||
      origin.pathname !== '/' ||
      origin.search ||
      origin.hash ||
      !env.EMAIL_INGEST_SECRET ||
      env.EMAIL_INGEST_SECRET.length < 32
    ) {
      throw new Error('Email relay configuration is invalid.');
    }
    if (
      !Number.isSafeInteger(message.rawSize) ||
      message.rawSize < 1 ||
      message.rawSize > MAX_RAW_BYTES
    ) {
      message.setReject('Email exceeds the 10 MiB capture limit or has an invalid size.');
      return;
    }
    const recipient = message.to.toLowerCase();
    if (recipient.length > 254 || /[\r\n]/.test(recipient)) {
      message.setReject('Invalid capture address.');
      return;
    }
    const timestamp = String(Date.now());
    const nonce = crypto.randomUUID();
    const signature = await signMetadata(
      env.EMAIL_INGEST_SECRET,
      timestamp,
      nonce,
      recipient,
      message.rawSize,
    );
    // Forward the native stream without a JavaScript per-chunk transform. The API
    // independently enforces the signed size and 10 MiB cap while reading it.
    const response = await fetch(`${origin.origin}/hooks/email-capture/raw`, {
      method: 'POST',
      // Workerd supports manual/follow; never forward signed headers on a redirect.
      redirect: 'manual',
      headers: {
        'content-type': 'message/rfc822',
        'x-omr-timestamp': timestamp,
        'x-omr-nonce': nonce,
        'x-omr-recipient': recipient,
        'x-omr-raw-size': String(message.rawSize),
        'x-omr-signature': signature,
      },
      body: message.raw,
      signal: AbortSignal.timeout(25000),
    });
    // Do not buffer or log a response body; the API owns actionable source status.
    await response.body?.cancel();
    const result = response.headers.get('x-omr-email-result');
    if (response.ok && result === 'accepted') {
      console.log(
        JSON.stringify({ event: 'email_relayed', requestId: nonce, bytes: message.rawSize }),
      );
      return;
    }
    if ([400, 403, 413].includes(response.status) && result === 'rejected') {
      message.setReject(
        'Email capture refused this message. Check the capture address, approved sender, and source status.',
      );
      return;
    }
    // A WAF denial, login page or proxy error is not an application decision.
    throw new Error(`Email capture is temporarily unavailable (${response.status}).`);
  },
};
