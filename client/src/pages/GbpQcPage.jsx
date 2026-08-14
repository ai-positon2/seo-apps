import { useState, useEffect, useRef } from 'react';
import { SectionHeader } from '../ui/SectionHeader';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { Badge } from '../ui/Badge';
import { EmptyState } from '../ui/EmptyState';
import { Field } from '../ui/Field';
import { ProgressSteps } from '../ui/ProgressSteps';
import { useToast } from '../ui/Toast';
import { gbpQc } from '../lib/gbpQcApi';
import QcResultView from '../components/gbpQc/QcResultView';
import GeneratedResultView from '../components/gbpQc/GeneratedResultView';
import AllLocationsView from '../components/gbpQc/AllLocationsView';

const WIZARD_STEPS = ['Select Client', 'Choose Stage', 'Post Type', 'Enter Content'];

const EMPTY_GEN = { inProgress: false, done: false, progress: 0, total: 0, currentLocation: '' };

export default function GbpQcPage() {
  const toast = useToast();

  const [step, setStep] = useState(1);
  const [clients, setClients] = useState([]);
  const [loadingClients, setLoadingClients] = useState(true);
  const [selectedClient, setSelectedClient] = useState(null);
  const [selectedStage, setSelectedStage] = useState(null);
  const [selectedPostType, setSelectedPostType] = useState(null);

  const [topic, setTopic] = useState('');
  const [baseContent, setBaseContent] = useState('');
  const [expandedContent, setExpandedContent] = useState('');
  const [location, setLocation] = useState('');
  const [genLocation, setGenLocation] = useState('');

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const [resultType, setResultType] = useState(null); // 'qc' | 'generated' | 'all'

  const [gen, setGen] = useState(EMPTY_GEN);
  const [allResults, setAllResults] = useState({});
  const esRef = useRef(null);

  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        setClients(await gbpQc.clients());
      } catch (e) {
        setError(e.message);
      } finally {
        setLoadingClients(false);
      }
    })();
  }, []);

  useEffect(() => () => esRef.current?.close(), []);

  function reset() {
    esRef.current?.close();
    setStep(1);
    setSelectedClient(null);
    setSelectedStage(null);
    setSelectedPostType(null);
    setTopic('');
    setBaseContent('');
    setExpandedContent('');
    setLocation('');
    setGenLocation('');
    setLoading(false);
    setError(null);
    setResult(null);
    setResultType(null);
    setAllResults({});
    setGen(EMPTY_GEN);
  }

  function selectClient(client) {
    setSelectedClient(client);
    setSelectedStage(null);
    setSelectedPostType(null);
    setStep(2);
  }

  function selectStage(stage) {
    setSelectedStage(stage);
    if ((selectedClient?.post_types || []).length === 1) {
      setSelectedPostType(selectedClient.post_types[0]);
      setStep(4);
    } else {
      setStep(3);
    }
  }

  function selectPostType(type) {
    setSelectedPostType(type);
    setStep(4);
  }

  async function submit() {
    setError(null);
    const key = selectedStage?.key;
    if (key === 'generate' && genLocation === '__all__') {
      await startGenerateAll();
      return;
    }
    setLoading(true);
    try {
      let response;
      if (key === 'base') {
        response = await gbpQc.qcBase({ client_id: selectedClient.id, topic, content: baseContent, post_type: selectedPostType });
      } else if (key === 'expanded') {
        response = await gbpQc.qcExpanded({
          client_id: selectedClient.id, base_content: baseContent, expanded_content: expandedContent,
          post_type: selectedPostType, location,
        });
      } else {
        response = await gbpQc.generate({ client_id: selectedClient.id, base_content: baseContent, location: genLocation, post_type: selectedPostType });
      }
      setResult(response);
      setResultType(key === 'generate' ? 'generated' : 'qc');
    } catch (e) {
      setError(e.message || 'An error occurred. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  async function startGenerateAll() {
    const total = selectedClient.locations.length;
    setGen({ inProgress: true, done: false, progress: 0, total, currentLocation: '' });
    setAllResults({});
    setResultType('all');
    setLoading(false);
    try {
      const { token } = await gbpQc.generateAllInit({ client_id: selectedClient.id, base_content: baseContent, post_type: selectedPostType });
      const es = new EventSource(`/api/gbp-qc/generate/all/stream/${token}`);
      esRef.current = es;
      es.addEventListener('progress', (e) => {
        const data = JSON.parse(e.data);
        setGen((g) => ({ ...g, progress: data.index, currentLocation: data.location }));
        setAllResults((prev) => ({ ...prev, [data.location]: data.result }));
      });
      es.addEventListener('done', () => {
        setGen((g) => ({ ...g, inProgress: false, done: true }));
        es.close();
      });
      es.onerror = () => {
        setGen((g) => {
          if (g.inProgress) setError('Connection dropped. Partial results shown above.');
          return { ...g, inProgress: false };
        });
        es.close();
      };
    } catch (e) {
      setError(e.message);
      setGen((g) => ({ ...g, inProgress: false }));
    }
  }

  async function copyText(text) {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      toast.add({ title: 'Copied to clipboard', variant: 'success' });
    } catch {
      toast.add({ title: 'Could not copy to clipboard', variant: 'danger' });
    }
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  async function downloadExcel() {
    setExporting(true);
    try {
      const res = resultType === 'qc'
        ? await gbpQc.exportQc({ result, client_id: selectedClient.id, stage: selectedStage.key, client_name: selectedClient.name })
        : await gbpQc.exportGenerated({ result, client_id: selectedClient.id, location: genLocation, client_name: selectedClient.name });
      downloadBlob(res.blob, res.filename);
      toast.add({ title: 'Excel file downloaded', variant: 'success' });
    } catch (e) {
      toast.add({ title: 'Export failed', description: e.message, variant: 'danger' });
    } finally {
      setExporting(false);
    }
  }

  async function downloadAllExcel() {
    setExporting(true);
    try {
      const res = await gbpQc.exportAll({ results: allResults, client_id: selectedClient.id, post_type: selectedPostType, client_name: selectedClient.name });
      downloadBlob(res.blob, res.filename);
      toast.add({ title: 'Excel file downloaded', variant: 'success' });
    } catch (e) {
      toast.add({ title: 'Export failed', description: e.message, variant: 'danger' });
    } finally {
      setExporting(false);
    }
  }

  const progressSteps = WIZARD_STEPS.map((label, i) => ({
    label,
    status: step > i + 1 ? 'done' : step === i + 1 ? 'active' : 'pending',
  }));

  return (
    <div style={{ maxWidth: 960, margin: '0 auto' }}>
      <SectionHeader
        eyebrow="Optimize"
        title="GBP Quality Check"
        subtitle="Review Google Business Profile posts against client brand guidelines, or generate location-customized content."
        actions={(step > 1 || resultType) ? <Button variant="secondary" onClick={reset}>New Session</Button> : null}
      />

      {error && (
        <Card style={{ marginBottom: 20 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ color: 'var(--danger)', flex: 1, fontSize: 13 }}>{error}</span>
            <Button variant="ghost" size="sm" onClick={() => setError(null)}>Dismiss</Button>
          </div>
        </Card>
      )}

      {!resultType && (
        <div style={{ marginBottom: 24 }}>
          <ProgressSteps steps={progressSteps} layout="horizontal" />
        </div>
      )}

      {!resultType && step === 1 && (
        loadingClients ? (
          <EmptyState title="Loading clients…" />
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 16 }}>
            {clients.map((client) => (
              <Card key={client.id} interactive onClick={() => selectClient(client)}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                  <div style={{
                    width: 40, height: 40, borderRadius: 10, background: 'var(--primary-soft)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontWeight: 700, color: 'var(--primary-text)', fontSize: 16,
                  }}>
                    {client.name.charAt(0)}
                  </div>
                  {client.has_generator && <Badge variant="brand">Generator</Badge>}
                </div>
                <div style={{ fontWeight: 600, fontSize: 15 }}>{client.name.split('(')[0].trim()}</div>
                <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 2 }}>
                  {(client.name.match(/\(([^)]+)\)/) || [])[1] || ''}
                </div>
                <div style={{ display: 'flex', gap: 14, fontSize: 12, color: 'var(--text-3)', marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
                  <span>{client.stages.length} stages</span>
                  <span>{client.post_types.length} post types</span>
                  {client.locations.length > 0 && <span>{client.locations.length} locations</span>}
                </div>
              </Card>
            ))}
          </div>
        )
      )}

      {!resultType && step === 2 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 16 }}>
          {(selectedClient?.stages || []).map((stage) => (
            <Card key={stage.key} interactive onClick={() => selectStage(stage)}>
              <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 6 }}>{stage.name}</div>
              <div style={{ fontSize: 12, color: 'var(--text-3)', lineHeight: 1.5 }}>{stage.description}</div>
            </Card>
          ))}
        </div>
      )}

      {!resultType && step === 3 && (
        <Card>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {(selectedClient?.post_types || []).map((type) => (
              <button
                key={type}
                onClick={() => selectPostType(type)}
                style={{
                  padding: '8px 16px', borderRadius: 100, fontSize: 13, cursor: 'pointer',
                  background: selectedPostType === type ? 'var(--primary-soft)' : 'var(--surface)',
                  border: `1px solid ${selectedPostType === type ? 'var(--primary)' : 'var(--border)'}`,
                  color: selectedPostType === type ? 'var(--primary-text)' : 'var(--text-2)',
                }}
              >
                {type}
              </button>
            ))}
          </div>
        </Card>
      )}

      {!resultType && step === 4 && selectedStage?.key === 'base' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Field label="Approved Topic / Title" value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="e.g. Benefits of Teeth Whitening" />
          <Field
            as="textarea" label="Base GBP Post Content" rows={11} value={baseContent}
            onChange={(e) => setBaseContent(e.target.value)} placeholder="Paste your base GBP post content here…"
            helper={`${baseContent.length} / 1500 characters`}
          />
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Button onClick={submit} loading={loading} disabled={!topic.trim() || !baseContent.trim() || loading}>
              {loading ? 'Running Check…' : 'Run QC Check'}
            </Button>
          </div>
        </div>
      )}

      {!resultType && step === 4 && selectedStage?.key === 'expanded' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Field label="Location Name" value={location} onChange={(e) => setLocation(e.target.value)} placeholder="e.g. Arlington, MA" />
          <Field as="textarea" label="Approved Base Content" rows={7} value={baseContent} onChange={(e) => setBaseContent(e.target.value)} placeholder="Paste the approved base content template…" />
          <Field
            as="textarea" label="Location-Specific Expanded Content" rows={11} value={expandedContent}
            onChange={(e) => setExpandedContent(e.target.value)} placeholder="Paste the location-specific version here…"
            helper={`${expandedContent.length} / 1500 characters`}
          />
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Button onClick={submit} loading={loading} disabled={!location.trim() || !baseContent.trim() || !expandedContent.trim() || loading}>
              {loading ? 'Running Check…' : 'Run QC Check'}
            </Button>
          </div>
        </div>
      )}

      {!resultType && step === 4 && selectedStage?.key === 'generate' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Field as="select" label="Select Location" value={genLocation} onChange={(e) => setGenLocation(e.target.value)}>
            <option value="">— Choose a location —</option>
            <option value="__all__">✦ All Locations ({selectedClient?.locations?.length} total)</option>
            {(selectedClient?.locations || []).map((loc) => (
              <option key={loc} value={loc}>{loc}</option>
            ))}
          </Field>
          {genLocation === '__all__' && (
            <div style={{ fontSize: 12, color: 'var(--primary-text)', background: 'var(--primary-soft)', border: '1px solid var(--border)', borderRadius: 'var(--r-md)', padding: 12 }}>
              Will generate posts for all {selectedClient?.locations?.length} locations. Progress updates stream live — this takes a few minutes.
            </div>
          )}
          <Field
            as="textarea" label="Approved Base Content" rows={11} value={baseContent}
            onChange={(e) => setBaseContent(e.target.value)} placeholder="Paste the approved base content here. The generator will customize it for each location…"
            helper={`${baseContent.length} characters`}
          />
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Button onClick={submit} loading={loading} disabled={!genLocation || !baseContent.trim() || loading}>
              {loading
                ? (genLocation === '__all__' ? 'Starting…' : 'Generating…')
                : (genLocation === '__all__' ? 'Generate All Locations' : 'Generate Content')}
            </Button>
          </div>
        </div>
      )}

      {resultType === 'qc' && result && (
        <QcResultView result={result} onExport={downloadExcel} exporting={exporting} onCopy={copyText} />
      )}

      {resultType === 'generated' && result && (
        <GeneratedResultView result={result} location={genLocation} onExport={downloadExcel} exporting={exporting} onCopy={copyText} />
      )}

      {resultType === 'all' && (
        <AllLocationsView
          gen={gen} allResults={allResults} clientName={selectedClient?.name} postType={selectedPostType}
          onDownload={downloadAllExcel} exporting={exporting} onCopy={copyText}
        />
      )}
    </div>
  );
}
