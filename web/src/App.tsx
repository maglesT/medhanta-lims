import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, can, type Me } from './api.js';
import { Login } from './pages/Login.js';
import { MyWork } from './floor/MyWork.js';
import { AnalysisScreen } from './floor/AnalysisScreen.js';
import { go, useRoute } from './api-floor.js';
import { Masters } from './designer/Masters.js';
import { Specs } from './specs/Specs.js';
import { Samples } from './samples/Samples.js';
import { Inventory } from './inventory/Inventory.js';
import { ToReview } from './release/ToReview.js';
import { ReleaseScreen } from './release/ReleaseScreen.js';
import { product } from './product.js';
import { OosList } from './oos/OosList.js';
import { OosScreen } from './oos/OosScreen.js';
import { Stability } from './stability/Stability.js';
import { Em } from './em/Em.js';

type Page = 'home' | 'masters' | 'specs' | 'samples' | 'inventory' | 'stability' | 'em';

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [page, setPage] = useState<Page>('home');
  // A demo installation says so on every screen, the sign-in screen too (GET /api/health needs no session).
  const [demo, setDemo] = useState(false);
  useEffect(() => { void api<{ demo?: boolean }>('GET', '/api/health', undefined, true).then((h) => setDemo(!!h.demo), () => {}); }, []);
  const banner = demo && <div className="demo-banner" role="note">DEMO · a demonstration installation, not for GMP use · waits can be skipped</div>;
  // Floor screens: #/analysis/12, #/analysis/12/step/0.1.0.1, #/analysis/12/approve (the tablet's back button works); the QC
  // and QA screens: #/release, #/release/12.
  const route = useRoute();
  const release = route.release;
  // The OOS tab: #/oos (the list), #/oos/3 (one OOS).
  const oos = route.oos;

  const refresh = useCallback(async () => {
    try {
      setMe(await api<Me>('GET', '/api/me'));
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setMe(null);
      else throw e;
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);
  // Real use of the screen (a tap, a key, e.g. typing 20 tablet weights before saving them) keeps the session alive as a
  // saved entry does, at most one call a minute; the 15-minute idle rule stays for an unattended screen (polls never
  // count), and the session still ends when core's sign-on does (8 hours). An idle-ended session shows Sign in at once.
  useEffect(() => {
    let last = Date.now();
    const used = () => { if (Date.now() - last > 60_000) { last = Date.now(); void refresh(); } };
    window.addEventListener('pointerdown', used);
    window.addEventListener('keydown', used);
    return () => { window.removeEventListener('pointerdown', used); window.removeEventListener('keydown', used); };
  }, [refresh]);
  // A analysis opened from another page (a analysis just issued from the master records) shows on the floor screens.
  useEffect(() => { if (route.analysis) setPage('home'); }, [route.analysis]);

  if (me === undefined) return <>{banner}<main className="page">Loading…</main></>;
  if (me === null) return <>{banner}<Login /></>;

  // Ends the core session too (shared terminals, one person per browser): the browser goes to core's sign-out page.
  const logout = async () => {
    const r = await api<{ logoutUrl: string | null }>('POST', '/api/logout');
    setMe(null);
    if (r.logoutUrl) window.location.assign(r.logoutUrl);
  };

  return (
    <>
      {banner}
      <header className="bar">
        <span className="brand"><img className="brand-mark" src="/truebatch-mark.svg" alt="" /><span><b>{product.name}</b><small>by Medhanta</small></span></span>
        <nav>
          <button className={page === 'home' && !route.analysis && !release && !oos ? 'tab on' : 'tab'} onClick={() => { setPage('home'); go('#/'); }}>My work</button>
          {can(me, 'analysis.review') && (
            <button className={release ? 'tab on' : 'tab'} onClick={() => { setPage('home'); go('#/release'); }}>To review</button>
          )}
          {['master.author', 'master.check', 'master.approve', 'analysis.perform', 'view'].some((c) => can(me, c)) && (
            <button className={page === 'masters' && !release && !oos ? 'tab on' : 'tab'} onClick={() => { setPage('masters'); go('#/'); }}>{product.masters}</button>
          )}
          {['master.author', 'master.check', 'master.approve', 'view'].some((c) => can(me, c)) && (
            <button className={page === 'specs' && !release && !oos ? 'tab on' : 'tab'} onClick={() => { setPage('specs'); go('#/'); }}>Specifications</button>
          )}
          {['sample.register', 'view'].some((c) => can(me, c)) && (
            <button className={page === 'samples' && !release && !oos ? 'tab on' : 'tab'} onClick={() => { setPage('samples'); go('#/'); }}>Samples</button>
          )}
          {['sample.register', 'qc.approve', 'master.author', 'master.check', 'master.approve', 'view'].some((c) => can(me, c)) && (
            <button className={page === 'stability' && !release && !oos ? 'tab on' : 'tab'} onClick={() => { setPage('stability'); go('#/'); }}>Stability</button>
          )}
          {['sample.register', 'qc.approve', 'master.author', 'master.check', 'master.approve', 'view'].some((c) => can(me, c)) && (
            <button className={page === 'em' && !release && !oos ? 'tab on' : 'tab'} onClick={() => { setPage('em'); go('#/'); }}>EM and water</button>
          )}
          {['view', 'analysis.perform', 'analysis.review', 'qc.approve', 'oos.approve'].some((c) => can(me, c)) && (
            <button className={oos ? 'tab on' : 'tab'} onClick={() => go('#/oos')}>OOS</button>
          )}
          {['analysis.perform', 'analysis.review', 'view'].some((c) => can(me, c)) && (
            <button className={page === 'inventory' && !release ? 'tab on' : 'tab'} onClick={() => { setPage('inventory'); go('#/'); }}>Inventory</button>
          )}
        </nav>
        <span className="who">
          {me.fullName}
          <button className="link" onClick={logout}>Log out</button>
        </span>
      </header>
      <main className="page">
        {oos ? (oos === 'list' ? <OosList me={me} /> : <OosScreen me={me} id={oos} />) : release ? (release === 'list' ? <ToReview me={me} /> : <ReleaseScreen me={me} id={release} />) : (<>
          {page === 'home' && (route.analysis ? <AnalysisScreen me={me} id={route.analysis} step={route.step} approve={route.approve} /> : <MyWork me={me} />)}
          {page === 'masters' && <Masters me={me} />}
          {page === 'specs' && <Specs me={me} />}
          {page === 'samples' && <Samples me={me} />}
          {page === 'inventory' && <Inventory me={me} />}
          {page === 'stability' && <Stability me={me} />}
          {page === 'em' && <Em me={me} />}
        </>)}
      </main>
    </>
  );
}
