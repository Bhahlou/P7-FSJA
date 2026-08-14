#!/usr/bin/env node
// Provisionne (ou remet à jour) la data view "operational-kpis" et le
// dashboard Kibana "KPI Opérationnels" (temps CI, qualité Sonar, fréquence
// des erreurs applicatives). Idempotent : réexécutable sans doublons.
//
// La fréquence des erreurs lit directement la data view "microcrm-back-*"
// existante (stack ELK) plutôt que de dupliquer ces logs ailleurs.
//
// Prérequis : stack ELK locale démarrée (docker compose -f docker-compose-elk.yml up -d).
//
// Usage : node misc/kpis/setup-kibana-dashboard.js

const path = require("node:path");
const {
  ensureKibanaReachable,
  upsertDataView,
  upsertDashboard,
  lensPanel,
  lensKeyValueTablePanel,
} = require(path.join("..", "lib", "kibana-lens.js"));

const KIBANA_URL = process.env.KIBANA_URL || "http://localhost:5601";
const DATA_VIEW_ID = "operational-kpis-dataview";
const DASHBOARD_ID = "operational-kpis-dashboard";
// Data view déjà créée lors de l'exercice de monitoring ELK (voir doc, 6.1).
const APP_LOGS_DATA_VIEW_ID = "5299a258-3dc5-4b76-88e1-d40fa11e7b55";

async function main() {
  console.log(`Vérification de Kibana (${KIBANA_URL})...`);
  await ensureKibanaReachable(KIBANA_URL);

  console.log("Création/mise à jour de la data view 'operational-kpis'...");
  await upsertDataView(KIBANA_URL, DATA_VIEW_ID, "operational-kpis");

  console.log("Création/mise à jour du dashboard 'KPI Opérationnels'...");
  const panels = [
    lensPanel({
      dataViewId: DATA_VIEW_ID,
      id: "ci-backend-panel",
      x: 0, y: 0, w: 24, h: 15,
      title: "CI Backend — temps de build vs temps de tests (s)",
      query: 'metric.keyword: "ci_duration" and component.keyword: "backend"',
      xField: "@timestamp",
      xLabel: "Date",
      yOp: "average",
      yField: "duration_seconds",
      yLabel: "Durée (s)",
      splitField: "step.keyword",
      splitLabel: "Étape",
      seriesType: "bar",
    }),
    lensPanel({
      dataViewId: DATA_VIEW_ID,
      id: "ci-frontend-panel",
      x: 24, y: 0, w: 24, h: 15,
      title: "CI Frontend — temps de build vs temps de tests (s)",
      query: 'metric.keyword: "ci_duration" and component.keyword: "frontend"',
      xField: "@timestamp",
      xLabel: "Date",
      yOp: "average",
      yField: "duration_seconds",
      yLabel: "Durée (s)",
      splitField: "step.keyword",
      splitLabel: "Étape",
      seriesType: "bar",
    }),
    lensKeyValueTablePanel({
      dataViewId: DATA_VIEW_ID,
      id: "sonar-table-panel",
      x: 0, y: 15, w: 16, h: 18,
      title: "Qualité SonarCloud (dernière analyse sur main)",
      query: 'metric.keyword: "sonar_quality"',
      labelField: "metric_label.keyword",
      labelSize: 10,
      rowLabel: "Métrique",
      valueField: "metric_value",
      valueLabel: "Valeur",
    }),
    lensPanel({
      dataViewId: APP_LOGS_DATA_VIEW_ID,
      id: "error-frequency-panel",
      x: 16, y: 15, w: 32, h: 18,
      title: "Fréquence des erreurs applicatives (logs ERROR dans le temps)",
      query: 'level.keyword: "ERROR"',
      xField: "@timestamp",
      xLabel: "Date",
      yOp: "count",
      yLabel: "Erreurs",
      seriesType: "bar",
    }),
  ];

  await upsertDashboard(KIBANA_URL, DASHBOARD_ID, {
    title: "KPI Opérationnels",
    description:
      "Temps de build/test CI, qualité SonarQube, fréquence des erreurs applicatives (ELK). Complète le dashboard DORA Metrics.",
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
