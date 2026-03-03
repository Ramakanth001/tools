import React, { useMemo, useState } from 'react';
import { Handle, Position } from 'reactflow';

const MAX_COLS_DEFAULT = 32;

function badge(text, variant) {
  return <span className={`tn-badge ${variant || ''}`}>{text}</span>;
}

export default function TableNode({ data }) {
  const {
    table,
    columns,
    fkColumns,
    indexedColumns,
    onSelect,
    selected,
    dimmed,
    highlight,
  } = data;

  const [showAllCols, setShowAllCols] = useState(false);

  const primaryKeySet = useMemo(() => new Set(table?.primaryKeyColumns || []), [table]);

  const visibleColumns = useMemo(() => {
    const list = Array.isArray(columns) ? columns : [];
    if (showAllCols) return list;
    return list.slice(0, MAX_COLS_DEFAULT);
  }, [columns, showAllCols]);

  const hiddenCount = Math.max(0, (columns?.length || 0) - visibleColumns.length);

  return (
    <div
      className={`tn ${selected ? 'tn--selected' : ''} ${dimmed ? 'tn--dim' : ''} ${highlight ? 'tn--hl' : ''}`}
      onClick={() => onSelect?.(table?.id)}
      role="button"
      tabIndex={0}
      onMouseEnter={() => data?.onHover?.(table?.id)}
      onMouseLeave={() => data?.onHover?.(null)}
    >
      <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />
      <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />

      <div className="tn-head">
        <div className="tn-title">
          <div className="tn-schema">{table?.schema}</div>
          <div className="tn-name">{table?.name}</div>
        </div>
        <div className="tn-meta">
          {table?.relkind && badge(table.relkind === 'r' ? 'table' : table.relkind, 'muted')}
          {Array.isArray(table?.primaryKeyColumns) && table.primaryKeyColumns.length > 0 ? badge('PK', 'pk') : null}
        </div>
      </div>

      <div className="tn-cols">
        {visibleColumns.map((c) => {
          const isPk = primaryKeySet.has(c.name);
          const isFk = fkColumns?.has?.(c.name) || false;
          const isIndexed = indexedColumns?.has?.(c.name) || false;
          return (
            <div key={c.name} className="tn-col">
              <div className="tn-col-left">
                <span className="tn-col-name">{c.name}</span>
                <span className="tn-col-type">{c.type}</span>
              </div>
              <div className="tn-col-right">
                {!c.notNull ? badge('NULL', 'null') : null}
                {isPk ? badge('PK', 'pk') : null}
                {isFk ? badge('FK', 'fk') : null}
                {isIndexed ? badge('IDX', 'idx') : null}
              </div>
            </div>
          );
        })}

        {hiddenCount > 0 ? (
          <button className="tn-more" type="button" onClick={(e) => (e.stopPropagation(), setShowAllCols(true))}>
            + {hiddenCount} more columns
          </button>
        ) : null}

        {showAllCols && (columns?.length || 0) > MAX_COLS_DEFAULT ? (
          <button className="tn-more" type="button" onClick={(e) => (e.stopPropagation(), setShowAllCols(false))}>
            Show less
          </button>
        ) : null}
      </div>
    </div>
  );
}
