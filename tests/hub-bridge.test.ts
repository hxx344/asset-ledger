import test from 'node:test';
import assert from 'node:assert/strict';
import { createHubBridge, trustedHubOrigin } from '../lib/hub-bridge.ts';

test('Hub origin is derived only from an exact proxy hostname in an iframe', () => {
  const location = { hostname: 'p-' + 'a'.repeat(24) + '.hub.localhost', protocol: 'http:', port: '9000' };
  assert.equal(trustedHubOrigin(location, true), 'http://hub.localhost:9000');
  assert.equal(trustedHubOrigin(location, false), null);
  for (const hostname of ['hub.localhost', 'p-short.hub.localhost', location.hostname + '.evil.test', 'evil.test']) assert.equal(trustedHubOrigin({ ...location, hostname }, true), null);
  assert.equal(trustedHubOrigin({ ...location, protocol: 'file:' }, true), null);
});

test('bridge handshakes both ways, ignores forged messages, handles navigation and releases listeners', () => {
  const sent: { message: Record<string, unknown>; origin: string }[] = [];
  const parent = { postMessage: (message: Record<string, unknown>, origin: string) => sent.push({ message, origin }) };
  let listener: ((event: MessageEvent) => void) | undefined;
  const target = {
    location: { hostname: 'p-' + 'b'.repeat(24) + '.hub.localhost', protocol: 'https:', port: '' }, parent,
    addEventListener: (_name: string, handler: typeof listener) => { listener = handler; },
    removeEventListener: (_name: string, handler: typeof listener) => { if (listener === handler) listener = undefined; },
  };
  const activities: boolean[] = [], navigations: string[] = [];
  const bridge = createHubBridge({ onActivity: active => activities.push(active), onNavigate: navigation => navigations.push(navigation.projectId) }, target as unknown as Window);
  const receive = (data: Record<string, unknown>, origin = 'https://hub.localhost', source: unknown = parent) => listener?.({ data: { channel: 'project-hub', version: 1, ...data }, origin, source } as MessageEvent);
  assert.equal(bridge.active, false);
  assert.equal(sent[0].message.role, 'module');
  assert.deepEqual(sent[0].message.capabilities, ['activity', 'changed', 'navigate']);
  receive({ type: 'ready', role: 'host' });
  assert.equal(sent.length, 2);
  receive({ type: 'activity', active: true }, 'https://evil.test');
  receive({ type: 'activity', active: true }, 'https://hub.localhost', {});
  receive({ type: 'activity', active: true, version: 2 });
  assert.deepEqual(activities, []);
  receive({ type: 'activity', active: true });
  assert.equal(bridge.active, true);
  receive({ type: 'activity', active: false });
  assert.deepEqual(activities, [true, false]);
  receive({ type: 'navigate', projectId: 'asset', query: {} });
  receive({ type: 'navigate', projectId: 'asset', query: { walletAddress: {} } });
  assert.deepEqual(navigations, ['asset']);
  bridge.changed();
  assert.deepEqual(sent.at(-1)?.message, { channel: 'project-hub', version: 1, type: 'changed', scope: 'summary' });
  assert.ok(sent.every(item => item.origin === 'https://hub.localhost'));
  bridge.dispose(); bridge.changed();
  assert.equal(listener, undefined);
  assert.equal(sent.length, 3);
});
