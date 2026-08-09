/**
 * Creates the single CloudCLI account when the instance has none.
 *
 * The app leaves POST /api/auth/register open until a first user exists, so an
 * unclaimed instance hands a shell to whoever reaches it first. Claiming the
 * account as part of the deploy closes that window.
 *
 * Runs inside the container (`docker exec … node /dev/stdin`), which is why it
 * talks to loopback and reads credentials from the environment.
 */
(async () => {
  const port = process.env.SERVER_PORT || '3001';
  const baseUrl = `http://127.0.0.1:${port}`;
  const username = process.env.ADMIN_USERNAME;
  const password = process.env.ADMIN_PASSWORD;

  if (!username || !password) {
    console.error('  ✗ ADMIN_USERNAME and ADMIN_PASSWORD must both be set');
    process.exit(1);
  }

  const statusResponse = await fetch(`${baseUrl}/api/auth/status`);
  if (!statusResponse.ok) {
    console.error(`  ✗ /api/auth/status returned ${statusResponse.status}`);
    process.exit(1);
  }

  const { needsSetup } = await statusResponse.json();
  if (!needsSetup) {
    console.log('  · account already claimed');
    return;
  }

  const registerResponse = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });

  if (!registerResponse.ok) {
    console.error(`  ✗ registration failed (${registerResponse.status}): ${await registerResponse.text()}`);
    process.exit(1);
  }

  console.log(`  ✓ account "${username}" created`);
})().catch((error) => {
  console.error(`  ✗ ${error.message}`);
  process.exit(1);
});
