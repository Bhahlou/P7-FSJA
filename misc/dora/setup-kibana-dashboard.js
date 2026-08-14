#!/usr/bin/env node
// Provisionne (ou remet à jour) la data view "dora-metrics" et le dashboard
// Kibana "DORA Metrics" via l'API Saved Objects. Idempotent : réexécutable
// sans créer de doublons (IDs fixes).
//
// Prérequis : stack ELK locale démarrée (docker compose -f docker-compose-elk.yml up -d).
//
// Usage : node misc/dora/setup-kibana-dashboard.js

const path = require("node:path");
const {
  ensureKibanaReachable,
  upsertDataView,
  upsertDashboard,
  lensPanel,
  lensSummaryTablePanel,
} = require(path.join("..", "lib", "kibana-lens.js"));

const KIBANA_URL = process.env.KIBANA_URL || "http://localhost:5601";
const DATA_VIEW_ID = "dora-metrics-dataview";
const DASHBOARD_ID = "dora-metrics-dashboard";

async function main() {
  console.log(`Vérification de Kibana (${KIBANA_URL})...`);
  await ensureKibanaReachable(KIBANA_URL);

  console.log("Création/mise à jour de la data view 'dora-metrics'...");
  await upsertDataView(KIBANA_URL, DATA_VIEW_ID, "dora-metrics");

  console.log("Création/mise à jour du dashboard 'DORA Metrics'...");
  const panels = [
    lensPanel({
      dataViewId: DATA_VIEW_ID,
      id: "leadtime-panel",
      x: 0, y: 0, w: 38, h: 15,
      title: "Lead Time par PR (min, une barre = une PR)",
      query: 'metric.keyword: "lead_time"',
      xField: "pr_number",
      xSize: 20,
      xDataType: "number",
      xLabel: "N° de PR",
      yOp: "average",
      yField: "lead_time_minutes",
      yLabel: "Lead time (min)",
      seriesType: "bar",
    }),
    lensSummaryTablePanel({
      dataViewId: DATA_VIEW_ID,
      id: "summary-table-panel",
      x: 38, y: 0, w: 10, h: 15,
      title: "Résumé DORA",
      query: 'metric.keyword: "summary"',
      columns: [
        { field: "lead_time_median_minutes", label: "Médiane Lead Time (min)" },
        { field: "deployment_success_count", label: "Déploiements réussis" },
        { field: "change_failure_rate_percent", label: "Taux d'échec (%)" },
      ],
    }),
    lensPanel({
      dataViewId: DATA_VIEW_ID,
      id: "freq-panel",
      x: 0, y: 15, w: 24, h: 15,
      title: "Fréquence de déploiement (déploiements réussis dans le temps)",
      query: 'metric.keyword: "deployment" and conclusion.keyword: "success"',
      xField: "@timestamp",
      xLabel: "Date",
      yOp: "count",
      yLabel: "Déploiements",
      seriesType: "bar_stacked",
    }),
    lensPanel({
      dataViewId: DATA_VIEW_ID,
      id: "cfr-panel",
      x: 24, y: 15, w: 24, h: 15,
      title: "Résultat des déploiements (succès vs échec)",
      query: 'metric.keyword: "deployment"',
      xField: "conclusion.keyword",
      xLabel: "Résultat",
      yOp: "count",
      yLabel: "Déploiements",
      seriesType: "bar",
    }),
  ];

  await upsertDashboard(KIBANA_URL, DASHBOARD_ID, {
    title: "DORA Metrics",
    description:
      "Lead Time, Deployment Frequency et Change Failure Rate calculés automatiquement depuis GitHub Actions. MTTR non inclus (voir doc).",
    panelsJSON: JSON.stringify(panels),
    optionsJSON: JSON.stringify({ useMargins: true, hidePanelTitles: false }),
    timeRestore: true,
    timeFrom: "now-90d",
    timeTo: "now",
    kibanaSavedObjectMeta: {
      searchSourceJSON: JSON.stringify({ query: { query: "", language: "kuery" }, filter: [] }),
    },
  });

  console.log(`\nDashboard prêt : ${KIBANA_URL}/app/dashboards#/view/${DASHBOARD_ID}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
