self.onmessage = async (event: MessageEvent<any>) => {
  const data = event.data || {};
  if (data.type !== 'hash' || !data.id || !data.buffer) return;
  try {
    const hashBuf = await crypto.subtle.digest('SHA-256', data.buffer as ArrayBuffer);
    const hash = Array.from(new Uint8Array(hashBuf))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    self.postMessage({ id: data.id, ok: true, hash });
  } catch (e: any) {
    self.postMessage({ id: data.id, ok: false, error: e?.message || 'hash failed' });
  }
};
