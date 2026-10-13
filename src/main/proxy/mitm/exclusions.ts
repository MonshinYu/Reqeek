export class MitmDenylist {
  private readonly denied = new Set<string>();

  has(host: string): boolean {
    return this.denied.has(host);
  }

  add(host: string): void {
    this.denied.add(host);
  }
}

/** TLS downgrade is allowed only before the client has completed its TLS handshake. */
export const mayFallbackToTunnel = (secureConnectionEstablished: boolean): boolean =>
  !secureConnectionEstablished;
