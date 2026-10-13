import { describe, expect, it } from 'vitest';
import { amzDates, encodeS3Path, signRequest } from '@/lib/storage/s3-signature';

describe('SigV4 signer', () => {
  it('matches the published AWS "GET Object" example', () => {
    // Example from the AWS Signature Version 4 test suite (service s3,
    // region us-east-1, access key AKIAIOSFODNN7EXAMPLE).
    const signed = signRequest({
      method: 'GET',
      path: '/test.txt',
      headers: {
        host: 'examplebucket.s3.amazonaws.com',
        range: 'bytes=0-9',
      },
      payload: '',
      region: 'us-east-1',
      service: 's3',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      date: new Date('2013-05-24T00:00:00.000Z'),
    });

    expect(signed.canonicalRequest).toBe(
      [
        'GET',
        '/test.txt',
        '',
        'host:examplebucket.s3.amazonaws.com',
        'range:bytes=0-9',
        'x-amz-content-sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        'x-amz-date:20130524T000000Z',
        '',
        'host;range;x-amz-content-sha256;x-amz-date',
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      ].join('\n'),
    );
    expect(signed.signature).toBe('f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
    expect(signed.headers.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, ' +
        'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, ' +
        'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
  });

  it('includes the payload hash so a tampered body invalidates the signature', () => {
    const base = {
      method: 'PUT',
      path: '/bucket/key.png',
      headers: { host: 'minio.local' },
      region: 'eu-west-1',
      accessKeyId: 'key',
      secretAccessKey: 'secret',
      date: new Date('2026-01-02T03:04:05.000Z'),
    };
    const a = signRequest({ ...base, payload: Buffer.from('one') });
    const b = signRequest({ ...base, payload: Buffer.from('two') });
    expect(a.headers.authorization).not.toBe(b.headers.authorization);
    expect(a.headers['x-amz-content-sha256']).toMatch(/^[0-9a-f]{64}$/);
    expect(a.amzDate).toBe('20260102T030405Z');
    expect(a.signature).toMatch(/^[0-9a-f]{64}$/);
  });

  it('sorts and trims headers into the canonical request', () => {
    const signed = signRequest({
      method: 'GET',
      path: '/x',
      headers: { 'X-Amz-Meta-B': ' two ', host: 'h', 'x-amz-meta-a': 'one' },
      payload: '',
      region: 'us-east-1',
      accessKeyId: 'k',
      secretAccessKey: 's',
      date: new Date('2026-01-01T00:00:00Z'),
    });
    expect(signed.canonicalRequest).toContain('host;x-amz-content-sha256;x-amz-date;x-amz-meta-a;x-amz-meta-b');
    // Header values are trimmed and whitespace-collapsed.
    expect(signed.canonicalRequest).toContain('x-amz-meta-b:two');
    expect(signed.headers.authorization).toContain('SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-meta-a;x-amz-meta-b');
  });

  it('formats dates and encodes paths the way S3 expects', () => {
    expect(amzDates(new Date('2026-07-04T12:34:56.789Z'))).toEqual({ amzDate: '20260704T123456Z', dateStamp: '20260704' });
    expect(encodeS3Path('/covers/a b.png')).toBe('/covers/a%20b.png');
    expect(encodeS3Path("/covers/o'brien.png")).toBe('/covers/o%27brien.png');
  });
});
