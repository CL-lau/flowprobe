import { execFileSync } from 'node:child_process';
import * as tls from 'node:tls';
import { EnvHttpProxyAgent } from 'undici';

/** Honor proxy settings and Apple's root store without disabling certificate verification. */
export function createModelDispatcher(): EnvHttpProxyAgent {
  const hasProxy = ['https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY'].some((key) =>
    Boolean(process.env[key]),
  );
  if (process.platform === 'darwin' && hasProxy) {
    try {
      const appleRoots = execFileSync(
        '/usr/bin/security',
        [
          'find-certificate',
          '-a',
          '-p',
          '/System/Library/Keychains/SystemRootCertificates.keychain',
        ],
        {
          encoding: 'utf8',
          timeout: 5000,
          maxBuffer: 2_000_000,
          stdio: ['ignore', 'pipe', 'ignore'],
        },
      );
      if (appleRoots.includes('-----BEGIN CERTIFICATE-----'))
        return new EnvHttpProxyAgent({
          requestTls: {
            ca: [...(tls.getCACertificates?.('default') ?? tls.rootCertificates), appleRoots],
          },
        });
    } catch {
      // Keep normal TLS verification if the platform certificate store cannot be read.
    }
  }
  return new EnvHttpProxyAgent();
}
