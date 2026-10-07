import { requestJson } from './apiRequest';

const BASE = '/api/semrush';

const req = (path, options) => requestJson(`${BASE}${path}`, options);

export const semrush = {
  balance: () => req('/balance'),
};
