// Signature VMP Castlabs (obligatoire pour que Widevine accepte de lire Netflix, Disney+, Prime Video… sur Windows).
// Lancée en "afterSign" : APRÈS que electron-builder a fini de modifier le .exe (icône, nom, version),
// sinon ces modifications cassent la signature et les vidéos protégées refusent de se lancer.
const { execSync } = require('child_process');

exports.default = async function (context) {
  if (process.env.SKIP_EVS === '1') {
    console.warn('[evs] SKIP_EVS=1 : build NON signé, la lecture ne marchera pas.');
    return;
  }
  const dir = context.appOutDir;
  console.log(`[evs] Signature VMP de ${dir}`);
  execSync(`python -m castlabs_evs.vmp sign-pkg "${dir}"`, { stdio: 'inherit' });
  execSync(`python -m castlabs_evs.vmp verify-pkg "${dir}"`, { stdio: 'inherit' });
  console.log('[evs] Signature VMP OK');
};
