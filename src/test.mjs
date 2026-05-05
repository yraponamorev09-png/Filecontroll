import assert from 'node:assert/strict';
import {
  generateOTPAuthURI,
  generateTOTP,
  generateTOTPSecret,
  secretToBase32,
  verifyTOTP,
} from './web/auth.ts';

const secret = generateTOTPSecret();
assert.equal(secret.length, 20, 'TOTP secret should be 20 bytes');

const base32 = secretToBase32(secret);
assert.match(base32, /^[A-Z2-7]+$/, 'Base32 secret should use RFC 4648 alphabet');

const uri = generateOTPAuthURI('user@example.com', base32, 'Vault PLM');
assert(uri.includes('otpauth://totp/'), 'OTP auth URI should use otpauth scheme');
assert(uri.includes(encodeURIComponent('user@example.com')), 'OTP auth URI should include the email');

const fixedTime = 1_700_000_000;
const originalNow = Date.now;

try {
  Date.now = () => fixedTime * 1000;
  const code = await generateTOTP(secret, fixedTime);
  assert.match(code, /^\d{6}$/, 'Generated TOTP should be 6 digits');
  assert.equal(await verifyTOTP(secret, code), true, 'Generated code should verify');
  assert.equal(await verifyTOTP(secret, '000000'), false, 'Invalid code should fail verification');
} finally {
  Date.now = originalNow;
}

console.log('Smoke tests passed');
