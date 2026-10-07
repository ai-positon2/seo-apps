import { requestJson, requestRaw } from './apiRequest';

const base = projectId => `/api/content-writer/projects/${encodeURIComponent(projectId)}/articles`;
// A proxy or gateway can answer with HTML, so an ok response may still not parse.
async function request(url, options) {
  const data = await requestJson(url, options);
  if (!data) throw new Error('The server returned an unreadable response.');
  return data;
}
export const contentWriterApi = {
  list: projectId => request(base(projectId)),
  get: (projectId, id) => request(`${base(projectId)}/${id}`),
  create: (projectId, document) => request(base(projectId), { method: 'POST', body: JSON.stringify(document) }),
  save: (projectId, id, revision, document) => request(`${base(projectId)}/${id}`, { method: 'PUT', body: JSON.stringify({ revision, document }) }),
  async generate(projectId, id, revision, stage, onEvent, signal) {
    const response = await requestRaw(`${base(projectId)}/${id}/${stage}`,
      { method: 'POST', body: JSON.stringify({ revision }), signal }, 'Generation failed');
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let buffer = '', result = null;
    try {
      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
        const events = buffer.split(/\r?\n\r?\n/); buffer = events.pop();
        for (const event of events) {
          const type = event.match(/^event: (.+)$/m)?.[1];
          const raw = event.match(/^data: (.+)$/m)?.[1];
          if (!type || !raw) continue;
          const data = JSON.parse(raw);
          if (type === 'fail') throw new Error(data.message);
          if (type === 'result') result = data;
          onEvent(type, data);
        }
        if (done) break;
      }
    } finally { reader.releaseLock(); }
    if (!result) throw new Error('Connection ended before completion. Reopen the article to check whether generation was saved.');
    return result;
  },
};
