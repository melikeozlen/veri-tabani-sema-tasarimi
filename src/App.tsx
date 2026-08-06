import { useMemo } from 'react';
import { DbmlErdViewer, type DbmlSource } from './components/DbmlErdViewer';

const dbmlModules = import.meta.glob('./**/*.dbml', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

function toSource(path: string, content: string): DbmlSource {
  const fileName = path.split('/').pop() ?? path;
  return {
    id: path,
    name: fileName,
    label: fileName.replace(/\.dbml$/i, ''),
    content,
  };
}

export default function App() {
  const sources = useMemo(
    () =>
      Object.entries(dbmlModules)
        .map(([path, content]) => toSource(path, content))
        .sort((a, b) => a.name.localeCompare(b.name, 'tr')),
    [],
  );

  return (
    <DbmlErdViewer
      sources={sources}
      title=" · Mantıksal Veri Modeli"
      height="100vh"
    />
  );
}
