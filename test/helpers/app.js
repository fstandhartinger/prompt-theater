import Stripe from 'stripe';
import { createApp } from '../../src/server.js';

export const WEBHOOK_SECRET = 'whsec_prompt_theater_test';
const signatures = new Stripe('sk_test_prompt_theater');

export const silentLogger = { log() {}, error() {}, warn() {} };

export const signedWebhook = (base, event) => {
  const payload = JSON.stringify(event);
  return fetch(`${base}/api/stripe/webhook`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'stripe-signature': Stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET })
    },
    body: payload
  });
};

export const checkoutEvent = (type, object) => ({
  id: `evt_${Math.random().toString(36).slice(2)}`, object: 'event', type,
  data: { object: { object: 'checkout.session', ...object } }
});

// A Stripe double that records every call and can be told to fail a given number of times.
export function stripeStub({ failRefunds = 0, failSessions = 0, paymentIntent = 'pi_test_1' } = {}) {
  const calls = { sessions: [], refunds: [], retrieved: [] };
  let refundFailures = failRefunds, sessionFailures = failSessions;
  return {
    calls,
    webhooks: signatures.webhooks,
    checkout: {
      sessions: {
        async create(args) {
          calls.sessions.push(args);
          if (sessionFailures-- > 0) throw new Error('Stripe: connection error to api.stripe.com (transient)');
          return { id: `cs_test_${calls.sessions.length}_${Date.now()}`, url: 'https://checkout.stripe.test/x' };
        },
        async retrieve(id) { calls.retrieved.push(id); return { id, payment_intent: paymentIntent }; }
      }
    },
    refunds: {
      async create(args, options) {
        calls.refunds.push({ args, options });
        if (refundFailures-- > 0) throw new Error('Stripe API is temporarily unavailable (503)');
        return { id: `re_test_${calls.refunds.length}` };
      }
    }
  };
}

export async function startApp(overrides) {
  const created = await createApp({ logger: silentLogger, ...overrides });
  const server = created.app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  return {
    ...created,
    base: `http://127.0.0.1:${server.address().port}`,
    async close() { await created.stop(); await new Promise(resolve => server.close(resolve)); }
  };
}
