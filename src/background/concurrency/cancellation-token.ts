export class CancellationToken {
  private cancelled = false;
  private listeners: Set<(reason: string) => void> = new Set();

  get isCancelled(): boolean {
    return this.cancelled;
  }

  cancel(reason = 'cancelled'): void {
    if (this.cancelled) return;
    this.cancelled = true;

    for (const listener of this.listeners) {
      try {
        listener(reason);
      } catch (error) {
        console.error('[CancellationToken] Listener error:', error);
      }
    }
  }

  onCancel(listener: (reason: string) => void): () => void {
    this.listeners.add(listener);

    // If already cancelled, invoke immediately
    if (this.cancelled) {
      listener('already cancelled');
    }

    return () => {
      this.listeners.delete(listener);
    };
  }

  throwIfCancelled(): void {
    if (this.cancelled) {
      throw new Error('Operation cancelled');
    }
  }
}

export class CancellationTokenSource {
  private token = new CancellationToken();

  getToken(): CancellationToken {
    return this.token;
  }

  cancel(reason?: string): void {
    this.token.cancel(reason);
  }
}
