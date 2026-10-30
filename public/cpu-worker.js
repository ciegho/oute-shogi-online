importScripts('engine.js', 'cpu.js');
self.onmessage = function (e) {
  var d = e.data;
  var mv = self.ShogiCPU.choose(d.state, d.level, d.budget);
  self.postMessage({ id: d.id, mv: mv });
};
