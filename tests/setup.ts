import '@testing-library/jest-dom';

// Before any test module imports the logger: `silent` builds a pino instance with no transport, so
// the suite neither spawns a worker thread per file nor writes into the real data directory.
process.env.LOG_LEVEL = 'silent';

afterEach(() => {
  // Clean up any pending timers or mocks
  vi.clearAllMocks();
});

afterAll(() => {
  vi.restoreAllMocks();
});
