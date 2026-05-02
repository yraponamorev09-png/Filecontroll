import { SupabaseClient } from '@supabase/supabase-js';

// TOTP implementation using Web Crypto API
const TOTP_PERIOD = 30;
const TOTP_DIGITS = 6;

function uint32ToBytes(n: number): Uint8Array {
  const buf = new Uint8Array(8);
  const view = new DataView(buf.buffer);
  view.setUint32(4, n, false);
  return buf;
}

async function hmacSha1(key: Uint8Array, message: Uint8Array): Promise<Uint8Array> {
  const keyBuf = new ArrayBuffer(key.byteLength);
  new Uint8Array(keyBuf).set(key);
  const msgBuf = new ArrayBuffer(message.byteLength);
  new Uint8Array(msgBuf).set(message);
  const cryptoKey = await crypto.subtle.importKey('raw', keyBuf, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, msgBuf);
  return new Uint8Array(sig);
}

function dynamicTruncation(hmac: Uint8Array): number {
  const offset = hmac[hmac.length - 1] & 0x0f;
  return ((hmac[offset] & 0x7f) << 24) |
         ((hmac[offset + 1] & 0xff) << 16) |
         ((hmac[offset + 2] & 0xff) << 8) |
         (hmac[offset + 3] & 0xff);
}

export async function generateTOTP(secret: Uint8Array, time?: number): Promise<string> {
  const t = Math.floor((time || Date.now() / 1000) / TOTP_PERIOD);
  const timeBytes = uint32ToBytes(t);
  const hmac = await hmacSha1(secret, timeBytes);
  const code = dynamicTruncation(hmac) % Math.pow(10, TOTP_DIGITS);
  return code.toString().padStart(TOTP_DIGITS, '0');
}

export async function verifyTOTP(secret: Uint8Array, code: string, window: number = 1): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  for (let i = -window; i <= window; i++) {
    const t = Math.floor(now / TOTP_PERIOD) + i;
    const timeBytes = uint32ToBytes(t);
    const hmac = await hmacSha1(secret, timeBytes);
    const expected = (dynamicTruncation(hmac) % Math.pow(10, TOTP_DIGITS)).toString().padStart(TOTP_DIGITS, '0');
    if (expected === code) return true;
  }
  return false;
}

export function generateTOTPSecret(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(20));
}

export function secretToBase32(secret: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const byte of secret) bits += byte.toString(2).padStart(8, '0');
  let result = '';
  for (let i = 0; i < bits.length; i += 5) {
    const chunk = bits.substring(i, i + 5);
    if (chunk.length < 5) break;
    result += alphabet[parseInt(chunk, 2)];
  }
  return result;
}

export function generateOTPAuthURI(email: string, secretBase32: string, issuer: string = 'Vault PLM'): string {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(email)}?secret=${secretBase32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_PERIOD}`;
}

// ============================================
// Auth service
// ============================================

export interface AuthState {
  user: any | null;
  profile: any | null;
  session: any | null;
  loading: boolean;
  mfaRequired: boolean;
}

export class AuthService {
  private sb: SupabaseClient;
  private state: AuthState = { user: null, profile: null, session: null, loading: true, mfaRequired: false };
  private listeners: ((state: AuthState) => void)[] = [];

  constructor(sb: SupabaseClient) {
    this.sb = sb;
    this.sb.auth.onAuthStateChange((event, session) => {
      (async () => {
        if (event === 'SIGNED_IN' && session) {
          await this.loadProfile(session.user.id);
        } else if (event === 'SIGNED_OUT') {
          this.state = { ...this.state, user: null, profile: null, session: null, mfaRequired: false };
        }
        this.notify();
      })();
    });
  }

  private async loadProfile(userId: string) {
    const { data } = await this.sb.from('user_profiles').select('*').eq('id', userId).maybeSingle();
    this.state = { ...this.state, profile: data };
  }

  private notify() {
    this.listeners.forEach(l => l(this.state));
  }

  onChange(listener: (state: AuthState) => void) {
    this.listeners.push(listener);
    return () => { this.listeners = this.listeners.filter(l => l !== listener); };
  }

  getState(): AuthState { return this.state; }

  async init(): Promise<AuthState> {
    const { data: { session } } = await this.sb.auth.getSession();
    if (session) {
      this.state = { ...this.state, user: session.user, session, loading: false };
      await this.loadProfile(session.user.id);

      // Check MFA via AAL level
      const { data: aalData } = await this.sb.auth.mfa.getAuthenticatorAssuranceLevel();
      const currentAal = (aalData as any)?.currentLevel;
      if (currentAal === 'aal1') {
        const { data: factorsData } = await this.sb.auth.mfa.listFactors();
        const verified = (factorsData as any)?.all?.filter((f: any) => f.status === 'verified') || [];
        if (verified.length > 0) {
          this.state.mfaRequired = true;
        }
      }
    } else {
      this.state = { ...this.state, loading: false };
    }
    this.notify();
    return this.state;
  }

  // ---- Email/Password Auth ----

  async signUp(email: string, password: string, fullName: string): Promise<{ error: string | null }> {
    const { error } = await this.sb.auth.signUp({
      email,
      password,
      options: { data: { full_name: fullName, role: 'viewer' } },
    });
    if (error) return { error: this.translateError(error) };
    return { error: null };
  }

  async signIn(email: string, password: string): Promise<{ error: string | null; mfaRequired?: boolean }> {
    const { error } = await this.sb.auth.signInWithPassword({ email, password });
    if (error) return { error: this.translateError(error) };

    // Check if MFA is needed
    const { data: aalData } = await this.sb.auth.mfa.getAuthenticatorAssuranceLevel();
    const currentAal = (aalData as any)?.currentLevel;
    if (currentAal === 'aal1') {
      this.state = { ...this.state, mfaRequired: true };
      this.notify();
      return { error: null, mfaRequired: true };
    }

    const { data: { session } } = await this.sb.auth.getSession();
    if (session) {
      this.state = { ...this.state, user: session.user, session };
      await this.loadProfile(session.user.id);
      await this.recordLogin(session.user.id);
    }
    this.notify();
    return { error: null };
  }

  async verifyMFA(code: string): Promise<{ error: string | null }> {
    try {
      const { data: factorsData } = await this.sb.auth.mfa.listFactors();
      const allFactors = (factorsData as any)?.all || [];
      const totpFactor = allFactors.find((f: any) => f.factor_type === 'totp' && f.status === 'verified');
      if (!totpFactor) return { error: '2FA не настроен' };

      const { data: challenge, error: challengeError } = await this.sb.auth.mfa.challenge({
        factorId: totpFactor.id,
      });
      if (challengeError) return { error: this.translateError(challengeError) };

      const { error: verifyError } = await this.sb.auth.mfa.verify({
        factorId: totpFactor.id,
        challengeId: challenge.id,
        code,
      });
      if (verifyError) return { error: 'Неверный код 2FA' };

      this.state = { ...this.state, mfaRequired: false };
      const { data: { session } } = await this.sb.auth.getSession();
      if (session) {
        this.state = { ...this.state, user: session.user, session };
        await this.loadProfile(session.user.id);
        await this.recordLogin(session.user.id);
      }
      this.notify();
      return { error: null };
    } catch (e: any) {
      return { error: e.message || 'Ошибка верификации 2FA' };
    }
  }

  async signOut(): Promise<void> {
    await this.sb.auth.signOut();
    this.state = { user: null, profile: null, session: null, loading: false, mfaRequired: false };
    this.notify();
  }

  async resetPassword(email: string): Promise<{ error: string | null }> {
    const { error } = await this.sb.auth.resetPasswordForEmail(email);
    if (error) return { error: this.translateError(error) };
    return { error: null };
  }

  async updatePassword(newPassword: string): Promise<{ error: string | null }> {
    const { error } = await this.sb.auth.updateUser({ password: newPassword });
    if (error) return { error: this.translateError(error) };
    return { error: null };
  }

  // ---- 2FA TOTP Setup ----

  async enable2FA(): Promise<{ secret: string; uri: string; factorId: string } | null> {
    try {
      const { data, error } = await this.sb.auth.mfa.enroll({
        factorType: 'totp',
        friendlyName: 'Vault PLM 2FA',
      });
      if (error || !data) { console.error('2FA enroll error:', error); return null; }
      const totpData = (data as any).totp || {};
      return {
        secret: totpData.secret || '',
        uri: totpData.uri || '',
        factorId: data.id,
      };
    } catch (e) {
      console.error('2FA enroll exception:', e);
      return null;
    }
  }

  async verify2FASetup(factorId: string, code: string): Promise<{ error: string | null }> {
    try {
      const { data: challenge, error: challengeError } = await this.sb.auth.mfa.challenge({ factorId });
      if (challengeError) return { error: this.translateError(challengeError) };

      const { error: verifyError } = await this.sb.auth.mfa.verify({
        factorId,
        challengeId: challenge.id,
        code,
      });
      if (verifyError) return { error: 'Неверный код. Попробуйте снова.' };

      const userId = this.state.user?.id;
      if (userId) {
        await this.sb.from('user_profiles').update({ totp_enabled: true, updated_at: new Date().toISOString() }).eq('id', userId);
        await this.loadProfile(userId);
      }
      this.notify();
      return { error: null };
    } catch (e: any) {
      return { error: e.message || 'Ошибка верификации' };
    }
  }

  async disable2FA(factorId: string): Promise<{ error: string | null }> {
    try {
      const { error } = await this.sb.auth.mfa.unenroll({ factorId });
      if (error) return { error: this.translateError(error) };

      const userId = this.state.user?.id;
      if (userId) {
        await this.sb.from('user_profiles').update({ totp_enabled: false, totp_secret: null, updated_at: new Date().toISOString() }).eq('id', userId);
        await this.loadProfile(userId);
      }
      this.notify();
      return { error: null };
    } catch (e: any) {
      return { error: e.message || 'Ошибка отключения 2FA' };
    }
  }

  // ---- Session Management ----

  async getActiveSessions(): Promise<any[]> {
    const userId = this.state.user?.id;
    if (!userId) return [];
    const { data } = await this.sb.from('user_sessions').select('*').eq('user_id', userId).eq('is_active', true).order('created_at', { ascending: false });
    return data || [];
  }

  async revokeSession(sessionId: string): Promise<void> {
    await this.sb.from('user_sessions').update({ is_active: false }).eq('id', sessionId);
  }

  async revokeAllOtherSessions(): Promise<void> {
    const userId = this.state.user?.id;
    if (!userId) return;
    await this.sb.from('user_sessions').update({ is_active: false }).eq('user_id', userId);
  }

  // ---- Helpers ----

  private async recordLogin(userId: string) {
    await this.sb.from('user_profiles').update({
      last_login_at: new Date().toISOString(),
      login_attempts: 0,
      locked_until: null,
    }).eq('id', userId);
  }

  private translateError(error: any): string {
    const msg = error?.message || '';
    if (msg.includes('Invalid login')) return 'Неверный email или пароль';
    if (msg.includes('Email not confirmed')) return 'Email не подтверждён';
    if (msg.includes('User already registered')) return 'Пользователь уже зарегистрирован';
    if (msg.includes('Password should be')) return 'Пароль слишком простой (минимум 6 символов)';
    if (msg.includes('rate limit')) return 'Слишком много попыток. Подождите.';
    if (msg.includes('same password')) return 'Новый пароль должен отличаться от текущего';
    return msg || 'Произошла ошибка';
  }
}
