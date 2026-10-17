import { BlockList, isIP } from 'node:net';

/** proxy-addr style keywords accepted in TRUST_PROXY (as Fastify understands them). */
const KEYWORDS: Record<string, [string, number, 'ipv4' | 'ipv6'][]> = {
  loopback: [
    ['127.0.0.0', 8, 'ipv4'],
    ['::1', 128, 'ipv6'],
  ],
  linklocal: [
    ['169.254.0.0', 16, 'ipv4'],
    ['fe80::', 10, 'ipv6'],
  ],
  uniquelocal: [
    ['10.0.0.0', 8, 'ipv4'],
    ['172.16.0.0', 12, 'ipv4'],
    ['192.168.0.0', 16, 'ipv4'],
    ['fc00::', 7, 'ipv6'],
  ],
};

/** `::ffff:1.2.3.4` → `1.2.3.4`. */
export function normalizeIp(ip: string): string {
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  return m ? m[1]! : ip;
}

/**
 * Compiles `config.trustProxy` (true / false / "loopback,uniquelocal" / IPs / CIDRs) into a
 * predicate over the socket peer address. Used to decide whether nginx-set identity headers
 * (Authelia `Remote-User` / `Remote-Groups`) may be believed. Unparseable entries are ignored.
 */
export function compileTrust(trust: string | boolean): (peer: string | undefined) => boolean {
  if (trust === true) return (peer) => !!peer;
  if (trust === false) return () => false;
  const list = new BlockList();
  for (const raw of trust.split(',')) {
    const item = raw.trim().toLowerCase();
    if (!item) continue;
    const kw = KEYWORDS[item];
    if (kw) {
      for (const [net, prefix, fam] of kw) list.addSubnet(net, prefix, fam);
      continue;
    }
    const [addr, bits] = item.split('/');
    const ip = normalizeIp(addr ?? '');
    const fam = isIP(ip);
    if (!fam) continue;
    const type = fam === 4 ? 'ipv4' : 'ipv6';
    if (bits === undefined) list.addAddress(ip, type);
    else if (/^\d+$/.test(bits)) list.addSubnet(ip, Number(bits), type);
  }
  return (peer) => {
    if (!peer) return false;
    const ip = normalizeIp(peer);
    const fam = isIP(ip);
    if (!fam) return false;
    return list.check(ip, fam === 4 ? 'ipv4' : 'ipv6');
  };
}
