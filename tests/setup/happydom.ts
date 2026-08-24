import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Registers window/document for component tests (bun test --preload this file).
GlobalRegistrator.register();

// react-virtual observes the scroll container; happy-dom has no layout engine,
// so provide a no-op observer. The grid falls back to a bounded window when
// measured height stays zero.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

const globalScope = globalThis as unknown as { ResizeObserver?: unknown };
if (!globalScope.ResizeObserver) {
  globalScope.ResizeObserver = ResizeObserverStub;
}
