// Helpers partagés pour provisionner des dashboards Kibana (data views +
// panneaux Lens) via l'API Saved Objects. Utilisé par misc/dora/ et
// misc/kpis/ — factorisé ici car le JSON Lens est fragile (plusieurs
// itérations ont été nécessaires pour trouver la forme correcte de chaque
// type de panneau) et dupliquer ce code entre scripts serait risqué.

async function kibanaRequest(kibanaUrl, method, path, body) {
  const res = await fetch(`${kibanaUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json", "kbn-xsrf": "true" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    throw new Error(`${method} ${path} -> ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

async function ensureKibanaReachable(kibanaUrl) {
  const status = await fetch(`${kibanaUrl}/api/status`).catch(() => null);
  if (!status?.ok) {
    throw new Error(
      `Kibana injoignable sur ${kibanaUrl}. Démarre la stack ELK : ` +
        `docker compose -f docker-compose-elk.yml up -d`
    );
  }
}

async function upsertDataView(kibanaUrl, id, title, timeFieldName = "@timestamp") {
  await fetch(`${kibanaUrl}/api/saved_objects/index-pattern/${id}`, {
    method: "DELETE",
    headers: { "kbn-xsrf": "true" },
  }).catch(() => {});
  await kibanaRequest(kibanaUrl, "POST", `/api/saved_objects/index-pattern/${id}`, {
    attributes: { title, timeFieldName },
  });
}

async function upsertDashboard(kibanaUrl, id, attributes) {
  await fetch(`${kibanaUrl}/api/saved_objects/dashboard/${id}`, {
    method: "DELETE",
    headers: { "kbn-xsrf": "true" },
  }).catch(() => {});
  await kibanaRequest(kibanaUrl, "POST", `/api/saved_objects/dashboard/${id}`, { attributes });
}

// Graphique XY (barres) : un axe X (date_histogram sur @timestamp, ou terms
// sur un champ keyword/numérique) et un axe Y (count, ou average d'un champ
// numérique — utilisé aussi pour afficher une valeur brute quand il n'y a
// qu'un document par bucket X, ex. lead time par PR).
function lensPanel({
  dataViewId, id, x, y, w, h, title, query,
  xField, xSize = 5, xDataType = "string", xLabel,
  yOp, yField, yLabel, seriesType,
  splitField, splitLabel, splitSize = 5,
}) {
  const layerId = `${id}-layer`;
  const xCol = `${id}-x`;
  const yCol = `${id}-y`;
  const splitCol = splitField ? `${id}-split` : null;
  return {
    type: "lens",
    gridData: { x, y, w, h, i: id },
    panelIndex: id,
    embeddableConfig: {
      attributes: {
        title: "",
        description: "",
        visualizationType: "lnsXY",
        type: "lens",
        references: [
          {
            type: "index-pattern",
            id: dataViewId,
            name: `indexpattern-datasource-layer-${layerId}`,
          },
        ],
        state: {
          visualization: {
            legend: { isVisible: true, position: "right" },
            valueLabels: "show",
            fittingFunction: "None",
            preferredSeriesType: seriesType,
            layers: [
              {
                layerId,
                accessors: [yCol],
                position: "top",
                seriesType,
                showGridlines: false,
                layerType: "data",
                xAccessor: xCol,
                ...(splitCol ? { splitAccessor: splitCol } : {}),
              },
            ],
          },
          query: { query, language: "kuery" },
          filters: [],
          datasourceStates: {
            formBased: {
              layers: {
                [layerId]: {
                  columns: {
                    [xCol]:
                      xField === "@timestamp"
                        ? {
                            label: xLabel || "Date",
                            customLabel: true,
                            dataType: "date",
                            operationType: "date_histogram",
                            sourceField: "@timestamp",
                            isBucketed: true,
                            scale: "interval",
                            params: { interval: "1d", includeEmptyRows: true, dropPartials: false },
                          }
                        : {
                            label: xLabel || xField,
                            customLabel: true,
                            dataType: xDataType,
                            operationType: "terms",
                            sourceField: xField,
                            isBucketed: true,
                            scale: "ordinal",
                            params: { size: xSize, orderBy: { type: "alphabetical" }, orderDirection: "asc" },
                          },
                    [yCol]:
                      yOp === "count"
                        ? {
                            label: yLabel || "Nombre",
                            customLabel: true,
                            dataType: "number",
                            operationType: "count",
                            isBucketed: false,
                            scale: "ratio",
                            sourceField: "___records___",
                            params: { emptyAsNull: true },
                          }
                        : {
                            label: yLabel || `Moyenne ${yField}`,
                            customLabel: true,
                            dataType: "number",
                            operationType: "average",
                            isBucketed: false,
                            scale: "ratio",
                            sourceField: yField,
                          },
                    ...(splitCol
                      ? {
                          [splitCol]: {
                            label: splitLabel || splitField,
                            customLabel: true,
                            dataType: "string",
                            operationType: "terms",
                            sourceField: splitField,
                            isBucketed: true,
                            scale: "ordinal",
                            params: { size: splitSize, orderBy: { type: "alphabetical" }, orderDirection: "asc" },
                          },
                        }
                      : {}),
                  },
                  columnOrder: splitCol ? [xCol, splitCol, yCol] : [xCol, yCol],
                  incompleteColumns: {},
                  sampling: 1,
                },
              },
            },
            indexpattern: { layers: {} },
            textBased: { layers: {} },
          },
          internalReferences: [],
          adHocDataViews: {},
        },
      },
      hidePanelTitles: false,
      enhancements: {},
    },
    title,
  };
}

// Tableau "une ligne par métrique" (format long : un document par métrique,
// avec un champ label + un champ valeur), plutôt que "une colonne par
// métrique" — plus lisible pour une liste de KPI, et permet d'afficher
// n'importe quel nombre de métriques sans redéfinir les colonnes.
function lensKeyValueTablePanel({ dataViewId, id, x, y, w, h, title, query, labelField, labelSize = 10, valueField, valueLabel, rowLabel }) {
  const layerId = `${id}-layer`;
  const labelCol = `${id}-label`;
  const valueCol = `${id}-value`;
  return {
    type: "lens",
    gridData: { x, y, w, h, i: id },
    panelIndex: id,
    embeddableConfig: {
      attributes: {
        title: "",
        description: "",
        visualizationType: "lnsDatatable",
        type: "lens",
        references: [
          {
            type: "index-pattern",
            id: dataViewId,
            name: `indexpattern-datasource-layer-${layerId}`,
          },
        ],
        state: {
          visualization: {
            layerId,
            layerType: "data",
            columns: [{ columnId: labelCol }, { columnId: valueCol }],
          },
          query: { query, language: "kuery" },
          filters: [],
          datasourceStates: {
            formBased: {
              layers: {
                [layerId]: {
                  columns: {
                    [labelCol]: {
                      label: rowLabel || "Métrique",
                      customLabel: true,
                      dataType: "string",
                      operationType: "terms",
                      sourceField: labelField,
                      isBucketed: true,
                      scale: "ordinal",
                      params: { size: labelSize, orderBy: { type: "alphabetical" }, orderDirection: "asc" },
                    },
                    [valueCol]: {
                      label: valueLabel || "Valeur",
                      customLabel: true,
                      dataType: "number",
                      operationType: "average",
                      isBucketed: false,
                      scale: "ratio",
                      sourceField: valueField,
                    },
                  },
                  columnOrder: [labelCol, valueCol],
                  incompleteColumns: {},
                  sampling: 1,
                },
              },
            },
            indexpattern: { layers: {} },
            textBased: { layers: {} },
          },
          internalReferences: [],
          adHocDataViews: {},
        },
      },
      hidePanelTitles: false,
      enhancements: {},
    },
    title,
  };
}

// Tableau affichant des valeurs déjà calculées côté script (typiquement un
// seul document "summary"/"quality" par dashboard), plutôt que de recalculer
// des agrégations mixtes (médiane + compte + ratio sur des sous-ensembles
// filtrés différents) dans Lens — trop fragile à exprimer en formules.
function lensSummaryTablePanel({ dataViewId, id, x, y, w, h, title, query, columns }) {
  const layerId = `${id}-layer`;
  const cols = columns.map((c, i) => ({ colId: `${id}-c${i}`, ...c }));
  return {
    type: "lens",
    gridData: { x, y, w, h, i: id },
    panelIndex: id,
    embeddableConfig: {
      attributes: {
        title: "",
        description: "",
        visualizationType: "lnsDatatable",
        type: "lens",
        references: [
          {
            type: "index-pattern",
            id: dataViewId,
            name: `indexpattern-datasource-layer-${layerId}`,
          },
        ],
        state: {
          visualization: {
            layerId,
            layerType: "data",
            columns: cols.map((c) => ({ columnId: c.colId })),
          },
          query: { query, language: "kuery" },
          filters: [],
          datasourceStates: {
            formBased: {
              layers: {
                [layerId]: {
                  columns: Object.fromEntries(
                    cols.map((c) => [
                      c.colId,
                      {
                        label: c.label,
                        customLabel: true,
                        dataType: "number",
                        operationType: "average",
                        isBucketed: false,
                        scale: "ratio",
                        sourceField: c.field,
                      },
                    ])
                  ),
                  columnOrder: cols.map((c) => c.colId),
                  incompleteColumns: {},
                  sampling: 1,
                },
              },
            },
            indexpattern: { layers: {} },
            textBased: { layers: {} },
          },
          internalReferences: [],
          adHocDataViews: {},
        },
      },
      hidePanelTitles: false,
      enhancements: {},
    },
    title,
  };
}

module.exports = {
  kibanaRequest,
  ensureKibanaReachable,
  upsertDataView,
  upsertDashboard,
  lensPanel,
  lensSummaryTablePanel,
  lensKeyValueTablePanel,
};
