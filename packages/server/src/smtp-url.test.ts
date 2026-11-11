import { describe, expect, it } from 'vitest';
import { parseSmtpUrl } from './smtp-url.js';

describe('SMTP_URL', () => {
  it('requires STARTTLS on smtp:// unless the URL says otherwise', () => {
    expect(parseSmtpUrl('smtp://relay.example.com')).toMatchObject({
      host: 'relay.example.com',
      port: 587,
      secure: false,
      requireTLS: true,
      ignoreTLS: false,
    });
  });

  it('uses TLS from the first byte on smtps://', () => {
    expect(parseSmtpUrl('smtps://relay.example.com')).toMatchObject({
      port: 465,
      secure: true,
      requireTLS: false,
      ignoreTLS: false,
    });
  });

  it('turns TLS off only for an explicit ?tls=none', () => {
    expect(parseSmtpUrl('smtp://mail.internal:1025?tls=none')).toMatchObject({
      port: 1025,
      secure: false,
      requireTLS: false,
      ignoreTLS: true,
    });
  });

  it('takes an IPv6 host without its brackets', () => {
    expect(parseSmtpUrl('smtp://[::1]:1025?tls=none')).toMatchObject({
      host: '::1',
      port: 1025,
      ignoreTLS: true,
    });
    expect(parseSmtpUrl('smtps://u:p@[2001:db8::25]').host).toBe('2001:db8::25');
  });

  it('decodes credentials', () => {
    expect(parseSmtpUrl('smtp://ada%40example.com:p%40ss%2Fword@relay.example.com').auth).toEqual({
      user: 'ada@example.com',
      pass: 'p@ss/word',
    });
  });

  it.each([
    ['http://relay.example.com', 'smtp:// or smtps://'],
    ['smtp://', 'no host'],
    ['not a url', 'not a valid URL'],
    ['smtp://relay.example.com/inbox', 'no path'],
    ['smtp://relay.example.com?tls=starttls', 'only the query parameter tls=none'],
    ['smtp://relay.example.com?requireTLS=false', 'only the query parameter tls=none'],
    ['smtps://relay.example.com?tls=none', 'contradicts smtps://'],
  ])('refuses %s', (url, why) => {
    expect(() => parseSmtpUrl(url)).toThrow(why);
  });

  it('never echoes the URL, which holds the password', () => {
    for (const url of ['smtp://u:hunter2@relay.example.com?tsl=none', 'ftp://u:hunter2@x']) {
      try {
        parseSmtpUrl(url);
        expect.unreachable();
      } catch (err) {
        expect(String(err)).not.toContain('hunter2');
      }
    }
  });
});
