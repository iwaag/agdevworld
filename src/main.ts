// The dashboard is the entrance. Phaser is loaded only for a world view.
const params = new URLSearchParams(location.search)
if (params.get('parts') === 'gauge') {
  void import('./gaugePanel').then(module => module.initGaugePanel())
} else if (params.get('parts') === 'graph') {
  void import('./operationParts').then(module => module.initOperationParts())
} else if (params.has('view') && params.get('parts') !== 'shell') {
  void import('./worldViews')
} else {
  void import('./operationDashboard').then(module => module.initOperationDashboard())
}
