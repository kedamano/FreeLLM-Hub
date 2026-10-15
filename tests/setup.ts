import '@testing-library/jest-dom';

afterEach(() => {
  // Clean up any pending timers or mocks
  vi.clearAllMocks();
});

afterAll(() => {
  vi.restoreAllMocks();
});
