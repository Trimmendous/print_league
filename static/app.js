let s;
let joinState={code:'',verified:false,googleAllowed:true,method:'password'},lastInviteLink='',inviteRequest=0;
let serverOffset=0, archivePage=0;
const root=document.querySelector('#app');
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const name=id=>{const u=s.users.find(u=>u.id===id);return esc(u?.display_name||u?.name||'Member');};
const eyeIcon='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/><path class="eye-slash" d="m4 4 16 16"/></svg>';
const form=(path,contents)=>`<form data-path="${path}">${contents.replace(/<input\b[^>]*type="password"[^>]*>/g,field=>`<span class="password-field">${field}<button type="button" class="password-toggle" aria-label="Show password" aria-pressed="false">${eyeIcon}</button></span>`)}</form>`;
const input=(n,p,type='text')=>`<input name="${n}" aria-label="${p}" placeholder="${p}" type="${type}" required>`;
const btn=(text)=>`<button>${text}</button>`;
async function post(path,data){return window.leagueAPI.request(path,{method:'POST',headers:{'X-CSRF-Token':s.csrf,...(data instanceof FormData?{}:{'Content-Type':'application/json'})},body:data instanceof FormData?data:JSON.stringify(data)});}
async function readState(){let state;try{state=await window.leagueAPI.request('state');}catch(error){if(error.status!==401)throw error;state=await window.leagueAPI.request('state');}if(location.hash==='#admin'&&state.user?.admin&&state.capabilities?.admin_management)state.admin=await window.leagueAPI.request('admin');return state;}
async function load(){s=await readState();serverOffset=(s.server_now?s.server_now*1000:Date.now())-Date.now();render();}
const avatar=u=>u.avatar?`<img class="avatar" ${window.LEAGUE_CONFIG?`data-avatar="${u.id}" data-version="${esc(u.avatar)}"`:`src="/api/users/${u.id}/avatar?v=${encodeURIComponent(u.avatar)}"`} alt="${esc(u.display_name||u.name)}’s profile photo" width="74" height="74">`:`<div class="avatar" aria-hidden="true">${esc((u.display_name||u.name).slice(0,1).toUpperCase())}</div>`;
const dateLabel=value=>{if(!value)return '';const d=new Date(typeof value==='number'?value*1000:value.length===10?value+'T23:59:59Z':value);return Number.isNaN(d.getTime())?'':d.toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short'});};
const deadlineMs=r=>new Date(r.deadline?.length===10?r.deadline+'T23:59:59Z':r.deadline).getTime();
const manager=r=>s.user.admin||r.creator_id===s.user.id;
const voyageBenchy='<svg viewBox="0 0 128 108" aria-hidden="true"><use href="/static/assets/benchy.svg#boat"/></svg>';
function voyage({start,end,title,endLabel,unit='competition',finished='Finish reached · competition deadline',startLabel='Start',finishLabel='Finish ⚑'}){return `<section class="voyage" data-start="${start}" data-end="${end}" data-unit="${esc(unit)}" data-finished="${esc(finished)}"><div class="voyage-heading"><span>${esc(title)}</span><strong class="countdown-clock">Calculating time…</strong></div><div class="voyage-course"><div class="voyage-boat-track" aria-hidden="true"><span class="voyage-boat">${voyageBenchy}</span></div><progress class="tide-progress" max="100" value="0" aria-label="${esc(unit)} time elapsed"></progress><div class="voyage-milestones"><span>${esc(startLabel)}</span><span>${esc(finishLabel)}</span></div></div><div class="voyage-labels"><span>${esc(endLabel)}</span><span>${esc(new Date(end).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short'}))}</span></div></section>`;}
function countdown(r){return voyage({start:(r.printing_started_at||r.created_at||Date.now()/1000)*1000,end:deadlineMs(r),title:'The voyage to the finish',endLabel:'Final printing deadline'});}
function pollCountdown(r){
 const collecting=r.phase==='submissions',scheduled=collecting?r.vote_opens_at:r.votes_close_at;
 const end=scheduled?Math.min(scheduled*1000,deadlineMs(r)):deadlineMs(r);
 const start=(collecting?r.created_at:r.voting_started_at||r.vote_opens_at||r.created_at)*1000;
 return voyage({start:Number.isFinite(start)?start:Date.now()+serverOffset,end,title:collecting?'1 · Topic collection':'2 · Topic voting',unit:collecting?'topic collection':'topic voting',endLabel:scheduled?(collecting?'Topic collection ends · voting opens':'Topic voting ends · printing starts'):'Latest possible close',finished:collecting?'Collection time reached · updating phase…':'Poll time reached · updating phase…',startLabel:collecting?'Suggest topics':'Cast your votes',finishLabel:collecting?'Voting →':'Printing →'})+(!scheduled?'<p class="muted small">An admin can end this phase manually. The timer shows the competition deadline, the latest possible close.</p>':'');
}

function tickClocks(){
 const now=Date.now()+serverOffset;
 document.querySelectorAll('.voyage').forEach(el=>{
  const end=Number(el.dataset.end),start=Number(el.dataset.start),seconds=Math.max(0,Math.ceil((end-now)/1000));
  el.querySelector('.countdown-clock').textContent=seconds?`${Math.floor(seconds/86400)}d ${String(Math.floor(seconds/3600)%24).padStart(2,'0')}h ${String(Math.floor(seconds/60)%60).padStart(2,'0')}m ${String(seconds%60).padStart(2,'0')}s remaining`:(el.dataset.finished||'Finish reached · competition deadline');
  const bar=el.querySelector('progress');bar.value=Math.max(0,Math.min(100,100*(now-start)/Math.max(1,end-start)));
  el.querySelector('.voyage-boat').style.left=`${bar.value}%`;
  bar.setAttribute('aria-valuetext',`${Math.round(bar.value)}% of ${el.dataset.unit||'competition'} time elapsed`);
  el.classList.toggle('voyage-finished',now>=end);
 });
 document.querySelectorAll('[data-poll-end]').forEach(el=>{
  const seconds=Math.max(0,Math.ceil((Number(el.dataset.pollEnd)*1000-now)/1000));
  el.textContent=seconds?`${Math.floor(seconds/86400)}d ${Math.floor(seconds/3600)%24}h ${Math.floor(seconds/60)%60}m ${seconds%60}s`:'Updating phase…';
 });
}
function organizer(){return `<details class="card organizer"><summary>⚓ Organizer workbench</summary><p class="muted small">Collect topics (optional) → vote on topics → finish prints → judge in person.</p>${form('rounds',`<label>Competition name<input name="title" maxlength="160" required></label><label class="check-label"><input name="prevote" type="checkbox" value="on"> 1 · Collect topic suggestions before voting (optional)</label><label class="prevote-time" hidden>1 → 2 · Topic collection ends / voting begins (optional)<input name="vote_opens_at" type="datetime-local" disabled><small>Topic submissions start when you create the competition. At this time, suggestions close and voting on those topics begins. Leave blank to start voting manually.</small></label><label>2 → 3 · Topic voting ends / printing begins (optional)<input name="votes_close_at" type="datetime-local"><small>Voting on the suggested topics ends and the selected topic moves into printing (ties need a decision). Leave blank to close topic voting manually; it cannot run past the final printing deadline.</small></label><label>3 · Final printing deadline<input name="deadline" type="datetime-local" required><small>Prints must be finished by this time. Judging happens in person afterward, and an admin records the winners.</small></label><p class="form-hint">All times use your local timezone. Enable a topic-submission period to collect suggestions before voting. Otherwise, topic suggestions and voting both open immediately. These voting dates choose what to print; they are not voting dates for finished prints.</p><button>Create competition</button>`)}</details>`;}
function winnersPage(){
 const past=s.rounds.filter(r=>r.phase==='completed').reverse(),pages=Math.max(1,Math.ceil(past.length/6));archivePage=Math.min(archivePage,pages-1);
 return `<div class="section-heading"><div><p class="eyebrow">A LITTLE WELL-EARNED GLORY</p><h1 class="page-title">Winners</h1></div><div class="winners-emblem">${trophyImage}</div></div><div class="crew-shelf">${[...s.users].sort((a,b)=>winsFor(b.id).length-winsFor(a.id).length).filter(u=>winsFor(u.id).length).map(u=>`<article class="crew-card"><div class="crew-identity">${avatar(u)}<h3>${name(u.id)}</h3></div>${tally(u.id)}</article>`).join('')||'<p class="muted">The first trophy is waiting for its captain.</p>'}</div><h2>Completed competitions</h2><div class="grid">${past.slice(archivePage*6,archivePage*6+6).map(round).join('')||'<div class="empty-state"><span>⚓</span><h3>A new fleet, a fresh start.</h3><p>Completed competitions and their winners will dock here.</p></div>'}</div>${pages>1?`<nav class="pagination" aria-label="Completed competitions"><button type="button" data-page="${archivePage-1}" ${archivePage===0?'disabled':''}>← Newer</button><span>Page ${archivePage+1} of ${pages}</span><button type="button" data-page="${archivePage+1}" ${archivePage===pages-1?'disabled':''}>Older →</button></nav>`:''}`;
}
const trophyImage='<img src="/static/assets/benchy-trophy.png" alt="" width="720" height="860" loading="lazy">';
function winsFor(id){return s.winners.filter(w=>s.rounds.some(r=>r.id===w.round_id&&r.phase==='completed')&&s.entries.some(e=>e.id===w.entry_id&&e.user_id===id));}
function tally(id){const wins=winsFor(id);return `<div class="tally" aria-label="${wins.length} ${wins.length===1?'win':'wins'}">${wins.length?Array.from({length:Math.min(wins.length,8)},()=>`<span class="tally-mark">${trophyImage}</span>`).join(''):'<span class="no-trophies">Your next great print starts here.</span>'}${wins.length>8?`<span>+${wins.length-8}</span>`:''}<strong>${wins.length} ${wins.length===1?'win':'wins'}</strong></div>`;}
function recoveryPanel(){return s.capabilities?.recovery&&s.user.has_password?`<section class="card"><h2>Account recovery</h2><p class="muted">Save recovery codes so you can reset your password without an email address. New codes replace the old set.</p>${form('profile/recovery-codes','<label>Current password<input name="current_password" type="password" autocomplete="current-password" required></label><button>Generate recovery codes</button>')}<pre id="recovery-codes" class="recovery-codes" hidden></pre></section>`:'';}
function profile(){return `<a class="back-link" href="#">← Back to the fleet</a><div class="section-heading"><div><p class="eyebrow">YOUR PLACE IN THE CREW</p><h1 class="page-title">Your profile</h1></div></div><div class="profile-grid"><aside class="card profile-card">${avatar(s.user)}<h2>${esc(s.user.display_name||s.user.name)}</h2><p class="muted">${s.user.name?'@'+esc(s.user.name):'Google sign-in'}</p><span class="badge">${s.user.admin?'Admin':'Crew member'}</span>${s.capabilities?.avatars===false?'<p class="muted small">Photo uploads are being migrated.</p>':form('profile/avatar','<label>Profile photo<input type="file" name="file" accept="image/jpeg,image/png,image/webp" required><small>JPEG, PNG, or WebP · up to 2 MB and 16 megapixels. Cropped to a 512 × 512 square.</small></label><button>Upload photo</button>')}<h3>Your trophy shelf</h3>${tally(s.user.id)}<p class="muted small">One trophy for each category won in a completed round.</p></aside><div><section class="card"><p class="eyebrow">CREW DETAILS</p><h2>What should we call you?</h2><p class="muted">Your display name appears on entries, votes, and the trophy shelf.</p>${form('profile',`<label>Display name<input name="display_name" value="${esc(s.user.display_name||s.user.name)}" maxlength="80" autocomplete="nickname" required></label><button>Save profile</button>`)}</section><section class="card"><p class="eyebrow">SIGN-IN DETAILS</p><h2>${s.user.has_password?'Username & password':'Add a password'}</h2><p class="muted">${s.user.has_password?'Use your current password to update your sign-in details. Other sessions will be signed out.':'Add a username and password to this account so you can also sign in without Google. A recent Google sign-in is required.'}</p>${form('profile/credentials',`<label>Username<input name="name" value="${esc(s.user.name)}" maxlength="40" autocomplete="username" data-check-username required><small class="username-status" aria-live="polite">Usernames are not case-sensitive.</small></label>${s.user.has_password?'<label>Current password<input name="current_password" type="password" autocomplete="current-password" required></label>':''}<label>New password<input name="password" type="password" minlength="6" maxlength="256" autocomplete="new-password" placeholder="At least 6 characters" required></label><label>Confirm new password<input name="confirm_password" type="password" minlength="6" maxlength="256" autocomplete="new-password" required></label><button>${s.user.has_password?'Update sign-in details':'Add username & password'}</button>`)}</section></div></div>`;}
const boardStages=[['ideas','On the horizon','Ideas & possibilities'],['progress','Under way','In progress'],['review','At the dock','In review']];
function featuresPage(){return `<div class="section-heading"><div><p class="eyebrow">A COURSE WE CHART TOGETHER</p><h1 class="page-title">What’s on the horizon?</h1><p class="muted">Bring an idea aboard. Follow it from a first thought to its final checks.</p></div><span class="section-number">⚓</span></div><details class="card idea-compose"><summary>+ Float an idea</summary>${form('features','<label>Your idea<input name="title" maxlength="120" placeholder="What would make the league better?" required></label><label>A little more detail<textarea name="description" maxlength="1000" rows="3" placeholder="How would it help the crew?"></textarea></label><button>Add to the horizon</button>')}<p class="muted small">Everyone can suggest ideas. Admins move them as work progresses.</p></details><div class="feature-board">${boardStages.map(([stage,title,subtitle],index)=>{
 const ideas=(s.feature_ideas||[]).filter(i=>i.stage===stage);
 return `<section class="board-lane lane-${stage}" aria-labelledby="lane-${stage}"><header><span class="lane-number">0${index+1}</span><div><h2 id="lane-${stage}">${title}</h2><p>${subtitle}</p></div><span class="lane-count">${ideas.length}</span></header><div class="lane-cards">${ideas.map(i=>`<article class="idea-card"><h3>${esc(i.title)}</h3>${i.description?`<p class="idea-description">${esc(i.description)}</p>`:''}<p class="idea-author">Floated by ${i.user_id?name(i.user_id):'Print League'}</p>${s.user.admin?form(`features/${i.id}/move`,`<label>Move to<select name="stage">${boardStages.map(([key,label])=>`<option value="${key}" ${stage===key?'selected':''}>${label}</option>`).join('')}</select></label><button>Move</button>`):''}${s.user.admin||(i.user_id===s.user.id&&stage==='ideas')?form(`features/${i.id}/delete`,'<button class="quiet-button">Remove idea</button>'):''}</article>`).join('')||`<div class="lane-empty"><span>${index===0?'✧':index===1?'≈':'⚓'}</span><p>${index===0?'Room for the next bright idea.':index===1?'Nothing under way just yet.':'Features in review go here.'}</p></div>`}</div></section>`;
 }).join('')}</div>`;}
function changelogPage(){return `<div class="section-heading"><div><p class="eyebrow">VERSION HISTORY</p><h1 class="page-title">Changelog</h1><p class="muted">Updates and improvements to Print League.</p></div><span class="log-symbol">≈</span></div><div class="release-log">${(s.releases||[]).map((release,index)=>`<article class="release-entry"><div class="release-marker"><span>v${esc(release.version)}</span><small>${esc(release.voyage)}</small></div><div class="card release-card"><p class="eyebrow">${index===0?'CURRENT RELEASE':'PREVIOUS RELEASE'}</p><h2>${esc(release.title)}</h2><p>${esc(release.summary)}</p>${release.changes?.length?`<ul>${release.changes.map(change=>`<li>${esc(change)}</li>`).join('')}</ul>`:''}</div></article>`).join('')}</div>`;}
function creditsPage(){
 return `<div class="section-heading"><div><p class="eyebrow">THE PEOPLE & IDEAS BEHIND IT</p><h1 class="page-title">Credits</h1><p class="muted">A little inspiration for a crew of makers.</p></div></div>
 <div class="credits-grid"><section class="card credit-card"><span class="credit-index">01 / INSPIRATION</span><h2>#3DBenchy</h2><p>The little benchmark boat that inspired our identity. Designed by <strong>Daniel Norée</strong> at <strong>Creative Tools</strong>; named and brought online by <strong>Paulo Kiefe</strong>.</p><p class="muted">The original #3DBenchy model is available under CC0 1.0.</p><div class="credit-links"><a href="https://www.3dbenchy.com/" target="_blank" rel="noopener noreferrer">3DBenchy ↗</a><a href="https://www.3dbenchy.com/license/" target="_blank" rel="noopener noreferrer">Credits & license ↗</a></div></section>
 <section class="card credit-card"><span class="credit-index">02 / THE TROPHY</span><h2>Something worth printing.</h2><p>Original trophy model credited to <strong>3DDoc</strong> in our supplied project. Our league’s “MAKING WAVES / IN 3D” version gives the physical prize its own identity.</p><p class="muted">The trophy image here is rendered from that actual 3D project.</p><div class="credit-trophy">${trophyImage}</div></section></div>`;
}
function printCard(link){
 const preview={image_url:link.preview_image};
 const host=String(link.url).match(/^https?:\/\/([^/]+)/i)?.[1]||'Print link';
 const platform=preview.platform||({'makerworld.com':'MakerWorld','www.makerworld.com':'MakerWorld','printables.com':'Printables','www.printables.com':'Printables'}[host.toLowerCase()])||'Shared print';
 const title=link.title===host?(preview.title||link.title):link.title;
 return `<article class="print-card" data-print-card="${link.id}"><a class="print-card-link" href="${esc(link.url)}" target="_blank" rel="noopener noreferrer"><div class="print-cover">${preview.image_url?`<img src="${esc(preview.image_url)}" alt="" loading="lazy" referrerpolicy="no-referrer" width="480" height="320">`:`<span class="print-placeholder" aria-hidden="true">${voyageBenchy}</span><span class="print-cover-label">FROM THE PRINT BED</span>`}</div><div class="print-card-copy"><span class="print-platform">${esc(platform)} <span aria-hidden="true">↗</span></span><h4>${esc(title)}</h4>${preview.description?`<p>${esc(preview.description)}</p>`:'<p>Explore the model, files, and printing details.</p>'}<span class="print-destination">View print on ${esc(platform==='Shared print'?host:platform)}</span></div></a><div class="print-card-footer"><small>Shared by ${name(link.user_id)}</small>${link.user_id===s.user.id?form(`print-links/${link.id}/delete`,'<button class="quiet-button">Remove</button>'):''}</div></article>`;
}
function printLinks(r, mine){
 const links=(s.print_links||[]).filter(link=>link.round_id===r.id);
 const awarded=s.winners.some(w=>w.round_id===r.id);
 if(r.phase!=='completed')return '';
 return `<section class="print-links"><h3>From the crew’s print beds</h3>${links.map(printCard).join('')||'<p class="muted small">No print links shared yet.</p>'}${mine?.status==='in'&&awarded?`<details class="share-link"><summary>+ Share a link to your print</summary>${form(`rounds/${r.id}/links`,'<label>Print title (optional)<input name="title" maxlength="120" placeholder="What did you make?"></label><p class="muted small">Share a MakerWorld or Printables model link so everyone can find the files.</p><label>Print URL<input name="url" type="url" maxlength="2048" placeholder="https://…" required></label><label>Preview image URL (optional)<input name="preview_image" type="url" maxlength="2048" placeholder="https://makerworld.bblmw.com/…"><small>Paste the model photo’s image address from MakerWorld or Printables. No file upload needed.</small></label><button>Share print link</button>')}</details>`:''}</section>`;
}

function joinInvite(){try{return location.hash.startsWith('#join=')?decodeURIComponent(location.hash.slice(6)):'';}catch{return '';}}
function invitationFields(inv){
 if(!s.capabilities?.admin_management)return '';
 const reusable=inv?.max_uses===null;
 return `<label>Label (optional)<input name="label" maxlength="80" value="${esc(inv?.label||'')}" placeholder="e.g. Weekend print crew"></label><label>Who can use this code?<select name="usage"><option value="once" ${!reusable?'selected':''} ${inv?.uses>1?'disabled':''}>One person, one time</option><option value="reusable" ${reusable?'selected':''}>Multiple people (reusable)</option></select></label><label>Expires<select name="expiry">${inv?'<option value="keep" selected>Keep current expiry</option>':''}<option value="1h">In 1 hour</option><option value="24h" ${!inv?'selected':''}>In 24 hours</option><option value="never">Never (indefinite)</option></select></label>`;
}
function invitationPanel(){return `<section class="card invitation-panel"><div><p class="eyebrow">GROW YOUR CREW</p><h2>Invite a member</h2><p>${s.capabilities?.admin_management?'Choose one-time use or let multiple people join with the same code and link.':'Generate a one-time invitation for a new member.'}</p></div>${form('invites',invitationFields()+btn('Generate invitation'))}<p id="invite" role="status"></p><div id="invite-share" hidden><label>Invitation code<input id="invite-code" readonly autocomplete="off"></label><button type="button" data-copy-invite="invite-code">Copy code</button><label>Signup link<input id="invite-link" readonly autocomplete="off"></label><button type="button" id="copy-invite" data-copy-invite="invite-link">Copy signup link</button><small>Copy now; the full code is shown only when generated. The signup link fills it in automatically.</small></div></section>`;}
function invitationManagement(){
 const invites=s.admin?.invitations||[];
 return `<section class="card"><h2>Manage invitations</h2><p>Editing keeps the same code and signup link. A new timed expiry starts when you save. Revoking a code stops future signups; existing members keep their accounts.</p>${invites.map(inv=>`<details class="invitation-item"><summary><strong>${esc(inv.label||'Invitation #'+inv.id)}</strong><span>${inv.revoked?'Revoked':inv.active?'Active':inv.max_uses!==null&&inv.uses>=inv.max_uses?'Used':'Expired'} · ${inv.uses} ${inv.uses===1?'signup':'signups'}</span></summary><p class="muted small">Invitation #${inv.id} · ${inv.max_uses===null?'Reusable by multiple people':'One-time use'} · ${inv.expires_at?'Expires '+esc(dateLabel(inv.expires_at)):'No expiry'}</p>${!inv.revoked&&!inv.restricted?form('admin/invitations/'+inv.id+'/edit',invitationFields(inv)+'<button>Save invitation</button>'):inv.restricted?'<p class="muted small">Reserved setup invitation; its settings cannot be changed.</p>':''}${!inv.revoked?form('admin/invitations/'+inv.id+'/revoke','<button class="danger-button">Revoke invitation</button>'):''}</details>`).join('')||'<p class="muted">No invitations yet.</p>'}</section>`;
}
function passwordSignup(){return form('auth/register',`<input type="hidden" name="invite" value="${esc(joinState.code)}"><label>Choose a username<input name="name" maxlength="40" autocomplete="username" data-check-username required><small class="username-status" aria-live="polite">Your public name in the league.</small></label><label>Password<input name="password" type="password" minlength="6" maxlength="256" autocomplete="new-password" placeholder="At least 6 characters" required></label><label>Confirm password<input name="confirm_password" type="password" minlength="6" maxlength="256" autocomplete="new-password" required></label><button>Create account</button>`);}
function joinPanel(){
 const google=!!s.capabilities?.google_client_id&&joinState.googleAllowed;
 return `<section class="card auth-panel" id="join-panel" aria-labelledby="join-heading"><p class="eyebrow">NEW TO THE CREW?</p><h2 id="join-heading">Join with an invitation</h2><p>Enter your invitation first, then choose how to create your account.</p>${!joinState.verified?`<form data-invite-gate><label>Invitation code *<input name="invite" value="${esc(joinState.code)}" autocomplete="off" maxlength="160" required></label><button>Continue with invitation</button><p id="invite-feedback" role="status"></p></form><small>* Required for every new account, including Google signup.</small>`:`<div class="invite-accepted" role="status"><span>✓ Invitation accepted</span><button type="button" class="quiet-button" data-change-invite>Change code</button></div><h3>Choose how to join</h3>${google?`<div class="signup-methods" role="group" aria-label="Create account with"><button type="button" data-join-method="password" aria-pressed="${joinState.method==='password'}">Username & password</button><button type="button" data-join-method="google" aria-pressed="${joinState.method==='google'}">Google</button></div>`:''}${google&&joinState.method==='google'?googleForm('register'):passwordSignup()}<small>* This invitation is used only when your account is created.</small>`}</section>`;
}
function authPage(){return `<div class="auth-heading"><p class="eyebrow">WELCOME TO PRINT LEAGUE</p><h1>Your next print starts here.</h1></div><div class="auth-columns ${location.hash==='#join'||joinInvite()?'joining':''}"><section class="card auth-panel" id="signin-panel" aria-labelledby="signin-heading"><p class="eyebrow">ALREADY A MEMBER?</p><h2 id="signin-heading">Sign in</h2><p>Use the sign-in method connected to your account.</p>${form('auth/login','<label>Username<input name="name" autocomplete="username" required></label><label>Password<input name="password" type="password" autocomplete="current-password" required></label><button>Sign in</button>')}${s.capabilities?.google_client_id?'<div class="auth-divider">or</div>'+googleForm('login'):''}<div id="signin-feedback" role="status"></div><details class="account-help"><summary>Need help signing in?</summary><p>Created your account with a password? Sign in above, then link Google from Settings → Profile.</p>${temporaryPasswordForm()}${s.capabilities?.recovery?`<details class="join"><summary>Recover your account</summary>${form('auth/recover','<label>Username<input name="name" autocomplete="username" required></label><label>Recovery code<input name="recovery_code" autocomplete="off" required></label><label>New password<input name="password" type="password" minlength="6" maxlength="256" autocomplete="new-password" required></label><label>Confirm new password<input name="confirm_password" type="password" minlength="6" maxlength="256" autocomplete="new-password" required></label><button>Reset password</button>')}</details>`:''}</details></section>${joinPanel()}</div>`;}
async function checkInvitation(code){
 const request=++inviteRequest;joinState.code=code.trim();
 const status=document.querySelector('#invite-feedback');if(status)status.textContent='Checking invitation…';
 try{const out=await post('auth/invitation',{invite:joinState.code});if(request!==inviteRequest||s.user)return;
  joinState.verified=true;joinState.googleAllowed=out.google_allowed;render();document.querySelector('#join-heading')?.scrollIntoView({block:'nearest',behavior:'smooth'});
 }catch(error){if(request!==inviteRequest)return;const target=document.querySelector('#invite-feedback');if(target)target.textContent=error.message;}
}
function adminPage(){
 const admin=s.admin;
 if(!admin)return '<section class="card"><h1>Admin</h1><p>Loading members…</p></section>';
 const members=admin.members||[];
 return `<div class="section-heading"><div><p class="eyebrow">ORGANIZER CONTROLS</p><h1 class="page-title">Admin</h1></div></div><div class="admin-stats"><section class="card"><strong>${admin.member_count}</strong><span>Members</span></section><section class="card"><strong>${admin.admin_count}</strong><span>Admins</span></section><section class="card"><strong>${admin.pending_invites}</strong><span>Active invitations</span></section></div>${invitationPanel()}${invitationManagement()}<section class="card"><h2>Crew members</h2><div id="temporary-password" hidden role="status"></div><p>Admins can manage competitions, invitations, and member access.</p>${members.map(u=>`<div class="row"><div><strong>${esc(u.display_name||u.name||'Member')}</strong><small class="member-detail">${u.name?'@'+esc(u.name):'Google account'} · ${u.admin?'Admin':'Member'}</small></div><div class="admin-member-actions">${form(u.admin?'admin/demote':'admin/promote',`<input type="hidden" name="member_id" value="${u.id}"><button>${u.admin?'Remove admin':'Make admin'}</button>`)}${u.has_password&&u.id!==s.user.id?form('admin/reset-password',`<input type="hidden" name="member_id" value="${u.id}"><button>Reset password</button>`):''}</div></div>`).join('')}</section>`;
}
function temporaryPasswordForm(){return `<details class="join"><summary>Have a temporary password from an admin?</summary>${form('auth/reset-password','<label>Username<input name="name" autocomplete="username" required></label><label>Temporary password<input name="temporary_password" type="password" autocomplete="off" required></label><label>New password<input name="password" type="password" minlength="6" maxlength="256" autocomplete="new-password" required></label><label>Confirm new password<input name="confirm_password" type="password" minlength="6" maxlength="256" autocomplete="new-password" required></label><button>Set new password</button>')}</details>`;}
function googleForm(mode){
 if(!s.capabilities?.google_client_id)return '';
 const fields=mode==='register'?`<input type="hidden" name="invite" value="${esc(joinState.code)}"><label>Username (optional)<input name="name" maxlength="40" autocomplete="username" data-check-username><small class="username-status" aria-live="polite">Leave blank to generate from your Gmail name.</small></label><p class="muted">Your username will be public. Leaving it blank uses the part before @gmail.com, adding a number if needed. Your full email stays private.</p><small data-google-required hidden>Choose an available username to continue.</small>`:'';
 return `<form data-google="${mode}" class="google-signin">${fields}<div data-google-button></div>${mode==='login'?'<small>For members who already joined or linked Google. New here? <a href="#join">Join with an invitation.</a></small>':mode==='register'?'<small>* Your invitation is required even when joining with Google.</small>':'<small>Connect Google to this existing membership.</small>'}</form>`;
}
function googleProfile(){
 if(!s.capabilities?.google_client_id)return '';
 return `<section class="card"><h2>Google sign-in</h2><p>${s.user.google_linked?'Google is linked to this membership.':'Link Google to sign in to this same membership. Your entries and wins stay together.'}</p>${s.user.google_linked?(s.user.has_password?form('profile/google/unlink','<button class="quiet-button">Disconnect Google</button>'):'<p class="muted">Add a username and password before disconnecting Google.</p>'):googleForm('link')}</section>`;
}
let googleLibrary;
function loadGoogle(){
 if(window.google?.accounts?.id)return Promise.resolve();
 if(!googleLibrary)googleLibrary=new Promise((resolve,reject)=>{const script=document.createElement('script');script.src='https://accounts.google.com/gsi/client';script.async=true;script.onload=resolve;script.onerror=()=>{googleLibrary=null;script.remove();reject(Error('Google sign-in could not load. Please try again.'));};document.head.appendChild(script);});
 return googleLibrary;
}
let googleGeneration=0,googleRefresh,googleChallenge;
async function hydrateGoogle(){
 const generation=++googleGeneration;clearTimeout(googleRefresh);
 if(!s.capabilities?.google_client_id)return;
 const forms=[...root.querySelectorAll('[data-google]')];if(!forms.length)return;
 try{
  await loadGoogle();if(generation!==googleGeneration)return;
  const key=s.user?'link:'+s.user.id:'login';
  if(!googleChallenge||googleChallenge.key!==key||googleChallenge.until<Date.now())googleChallenge={key,until:Date.now()+230000,pending:post('auth/google/challenge',{mode:s.user?'link':'login'})};
  const challenge=await googleChallenge.pending;
  if(generation!==googleGeneration||!forms[0].isConnected)return;
  window.google.accounts.id.initialize({client_id:challenge.client_id,nonce:challenge.nonce,auto_select:false,ux_mode:'popup',use_fedcm_for_button:true,callback:async response=>{
   const f=forms.find(form=>form.dataset.google===response.state);if(!f||!f.isConnected||!f.reportValidity())return;
   const body=Object.fromEntries(new FormData(f));body.mode=f.dataset.google;if(body.mode==='register')body.username_mode=body.name?.trim()?'custom':'gmail';
   try{await post('auth/google',{...body,challenge:challenge.challenge,credential:response.credential});googleChallenge=null;if(body.mode!=='link')location.hash='';await load();document.querySelector('#message').textContent=body.mode==='link'?'Google account linked.':'Signed in.';}
   catch(error){
    const feedback=body.mode==='login'?document.querySelector('#signin-feedback'):document.querySelector('#message');
    feedback.textContent=error.message;
    if(error.code==='google_account_unlinked'){const link=document.createElement('a');link.href='#join';link.textContent='Join with an invitation →';feedback.append(document.createElement('br'),link);}
    void hydrateGoogle();
   }
  }});
  forms.forEach(f=>{const slot=f.querySelector('[data-google-button]');slot.replaceChildren();window.google.accounts.id.renderButton(slot,{type:'standard',theme:'outline',size:'large',width:280,text:f.dataset.google==='register'?'signup_with':'signin_with',state:f.dataset.google});});
  googleRefresh=setTimeout(()=>{if(forms[0].isConnected)void hydrateGoogle();},240000);
 }catch(error){googleChallenge=null;if(generation===googleGeneration)document.querySelector('#message').textContent=error.message;}
}
function updateGoogleSignup(f){
 if(f?.dataset.google!=='register')return;
 const ready=f.checkValidity();f.querySelector('[data-google-button]').hidden=!ready;f.querySelector('[data-google-required]').hidden=ready;
}
root.addEventListener('input',e=>updateGoogleSignup(e.target.form));
root.addEventListener('change',e=>updateGoogleSignup(e.target.form));
root.addEventListener('click',async e=>{
 const copy=e.target.closest('[data-copy-invite]');
 if(copy){const field=document.getElementById(copy.dataset.copyInvite);try{await navigator.clipboard.writeText(field.value);document.querySelector('#message').textContent=copy.dataset.copyInvite==='invite-code'?'Invitation code copied.':'Signup link copied.';}catch{field.select();document.querySelector('#message').textContent='Copy the selected invitation.';}return;}
 const method=e.target.closest('[data-join-method]');if(method){joinState.method=method.dataset.joinMethod;render();return;}
 if(e.target.closest('[data-change-invite]')){++inviteRequest;joinState.verified=false;render();document.querySelector('[data-invite-gate] input')?.focus();}
});

const avatarBlobs=new Map();
async function hydrateAvatars(){
 if(!window.LEAGUE_CONFIG)return;
 if(!s.user){for(const entry of avatarBlobs.values())if(entry.url)URL.revokeObjectURL(entry.url);avatarBlobs.clear();return;}
 for(const img of document.querySelectorAll('[data-avatar]')){
  const id=img.dataset.avatar,key=id+':'+img.dataset.version;
  let entry=avatarBlobs.get(key);
  if(!entry){entry={};avatarBlobs.set(key,entry);entry.pending=window.leagueAPI.image(id).then(blob=>{if(!s.user||avatarBlobs.get(key)!==entry)return;entry.url=URL.createObjectURL(blob);}).catch(()=>{avatarBlobs.delete(key);});}
  await entry.pending;if(entry.url&&img.isConnected)img.src=entry.url;
 }
 const valid=new Set((s.users||[]).filter(u=>u.avatar).map(u=>u.id+':'+u.avatar));
 for(const [key,entry] of avatarBlobs)if(!valid.has(key)){if(entry.url)URL.revokeObjectURL(entry.url);avatarBlobs.delete(key);}
}
function render(){
 renderContent();void hydrateAvatars();void hydrateGoogle();
 const invite=joinInvite();if(!s.user&&invite&&invite!==lastInviteLink){lastInviteLink=invite;joinState.code=invite;const input=document.querySelector('[data-invite-gate] input');if(input)input.value=invite;void checkInvitation(invite);}
 if(!s.user&&(location.hash==='#join'||invite))document.querySelector('#join-heading')?.scrollIntoView?.({block:'nearest'});
}
function renderContent(){
 document.body?.classList.toggle('signed-out',!s.user);
 document.querySelector('#settings').hidden=!s.user;
 document.querySelector('#admin-link').hidden=!s.user?.admin||!s.capabilities?.admin_management;
 const username=document.querySelector('#header-username');
 username.hidden=!s.user;username.textContent=s.user?.name||s.user?.display_name||'';
 const release=s.releases?.[0];if(release)document.querySelector('#brand-version').textContent=`v${release.version} · ${release.voyage}`;
 document.querySelector('#page-tabs').hidden=!s.user;
 document.querySelector('#tab-home').setAttribute('aria-current',location.hash===''||location.hash==='#'?'page':'false');
 document.querySelector('#tab-winners').setAttribute('aria-current',location.hash==='#winners'?'page':'false');
 document.querySelector('#tab-features').setAttribute('aria-current',location.hash==='#features'?'page':'false');
 document.querySelector('#tab-changelog').setAttribute('aria-current',location.hash==='#changelog'?'page':'false');
 document.querySelector('#tab-credits').setAttribute('aria-current',location.hash==='#credits'?'page':'false');
 const isProfile=s.user&&location.hash==='#profile';
 document.querySelector('#intro').hidden=true;
 if(!s.user){root.innerHTML=authPage();return;}
 if(isProfile){root.innerHTML=profile()+googleProfile()+recoveryPanel();return;}
 if(location.hash==='#admin'){root.innerHTML=s.user.admin?adminPage():'<section class="card"><h1>Administrator access required</h1></section>';return;}
 if(location.hash==='#credits'){root.innerHTML=creditsPage();return;}
 if(location.hash==='#features'){root.innerHTML=featuresPage();return;}
 if(location.hash==='#changelog'){root.innerHTML=changelogPage();return;}
 if(location.hash==='#winners'){root.innerHTML=winnersPage();return;}
 root.innerHTML=`<div class="welcome"><div><p class="eyebrow">GOOD TO HAVE YOU ABOARD</p><h1 class="page-title">On the workbench</h1><p class="muted">Pick a topic, cast your vote, and make something worth sharing.</p></div></div>${s.user.admin?invitationPanel()+organizer():''}<div class="grid">${s.rounds.filter(r=>r.phase!=='completed').map(round).join('')||'<div class="empty-state"><span>≈</span><h3>Calm seas. Fresh possibilities.</h3><p>The next challenge starts when your organizer creates a competition.</p></div>'}</div>`;
 tickClocks();
}

function round(r){
 const base=`rounds/${r.id}/`,topics=s.topics.filter(t=>t.round_id===r.id),entries=s.entries.filter(e=>e.round_id===r.id),parts=s.participants.filter(p=>p.round_id===r.id),mine=parts.find(p=>p.user_id===s.user.id),canManage=manager(r);
 const collecting=r.phase==='submissions'||(r.phase==='topics'&&!r.has_prevote);
 const phaseLabels={submissions:'Collecting topics',topics:'Voting open',tie:'Voting closed · tie',no_topics:'Voting closed · no topics',printing:'Printing underway',judging:'Judging',completed:'Completed'};
 const voteCount=t=>s.votes.filter(v=>v.topic_id===t.id&&v.round_id===r.id).length;
 const topCount=Math.max(0,...topics.map(voteCount));
 const tied=topics.filter(t=>voteCount(t)===topCount);
 const eligible=entries.filter(e=>parts.some(p=>p.user_id===e.user_id&&p.status==='in'));
 let controls='';
 if(canManage){
  if(r.phase==='submissions')controls=form(base+'open-voting',btn('Open voting now →'));
  if(r.phase==='topics')controls=form(base+'close-poll',btn('Close poll now →'));
  if(r.phase==='tie')controls=form(base+'resolve-tie',`<label>Choose among tied leaders<select name="topic_id" required>${tied.map(t=>`<option value="${t.id}">${esc(t.title)} · ${voteCount(t)} votes</option>`).join('')}</select></label>`+btn('Confirm winning topic →'));
  if(r.phase==='no_topics')controls=(deadlineMs(r)>Date.now()+serverOffset?form(base+'reopen-topics',btn('Reopen topic collection')):'')+form(base+'archive-empty',btn('Archive without awards'));
  if(r.phase==='printing')controls=form(base+'advance',btn('End printing & start judging →'));
  if(r.phase==='judging')controls=(eligible.length&&s.user.admin?form(base+'winner',input('category','Award category')+`<select name="entry_id" aria-label="Winning entry">${eligible.map(e=>`<option value="${e.id}">${esc(e.title)} — ${name(e.user_id)}</option>`).join('')}</select>`+btn('Record winner')):`<p class="muted">${eligible.length?'An admin will record the in-person results.':'No eligible entries were submitted. You can archive this competition without awards.'}</p>`)+form(base+'advance',btn('Complete competition →'));
  if(s.user.admin)controls+=form(base+'delete-competition','<button class="danger-button">Delete competition</button>');
 }
 return `<section class="card round-card"><span class="badge">${phaseLabels[r.phase]||esc(r.phase)}</span><h2>${esc(r.title)}</h2><p class="muted">Competition ends: ${esc(dateLabel(r.deadline))}</p>
 ${r.topic?`<div class="winning-topic"><p class="eyebrow">THE CREW’S WINNING TOPIC</p><h3>${esc(r.topic)}</h3></div>`:''}
 ${['printing','judging'].includes(r.phase)?countdown(r):['submissions','topics'].includes(r.phase)?pollCountdown(r):''}
 ${r.phase==='submissions'?'<p class="phase-note">Every member can suggest multiple distinct topics. Voting opens after this collection phase; the list is then frozen.</p>':''}
 ${r.phase==='topics'?`<p class="phase-note">Vote for as many topics as you like, once per topic.${r.has_prevote?' Topic collection has ended; the list is frozen.':' Every member can also suggest more topics until voting closes.'}</p>`:''}
 ${r.phase==='tie'?'<p class="phase-note">The poll is closed with a tie. The creator or an admin will choose among the tied leaders before printing begins.</p>':''}
 ${r.phase==='no_topics'?'<p class="phase-note">The poll closed without any topics. There is no winning topic.</p>':''}
 ${r.phase==='judging'?'<p class="phase-note">Submissions are closed. Voting happens in person; an admin will record the winners here.</p>':''}
 ${['submissions','topics','tie'].includes(r.phase)?`<div class="topic-list">${topics.map(t=>`<div class="row"><span><strong>${esc(t.title)}</strong><br><small>${t.user_id?`Suggested by ${name(t.user_id)} · `:''}${r.phase==='submissions'?'Voting opens later':`${voteCount(t)} votes`}</small></span><div class="topic-actions">${r.phase==='topics'?form(base+'vote',`<input type="hidden" name="topic_id" value="${t.id}">`+`<button ${s.votes.some(v=>v.topic_id===t.id&&v.user_id===s.user.id)?'disabled aria-label="Already voted for this topic"':''}>${s.votes.some(v=>v.topic_id===t.id&&v.user_id===s.user.id)?'✓ Voted':'Vote'}</button>`):''}${collecting&&t.user_id===s.user.id&&voteCount(t)===0?form(base+'delete-topic',`<input type="hidden" name="topic_id" value="${t.id}"><button class="quiet-button" aria-label="Delete topic: ${esc(t.title)}">Delete</button>`):''}</div></div>`).join('')||'<p class="muted">No topics yet. Bring the first idea aboard.</p>'}</div>`:''}
 ${collecting?form(base+'topic',input('title','Suggest a topic')+btn('Add topic')):''}
 ${['submissions','topics','tie','printing'].includes(r.phase)&&deadlineMs(r)>Date.now()+serverOffset?form(base+'participate',`<label>Are you participating?<select name="status" aria-label="Are you participating?" required><option value="" disabled ${!mine?'selected':''}>Choose Yes or No</option><option value="in" ${mine?.status==='in'?'selected':''}>Yes</option><option value="out" ${mine?.status==='out'?'selected':''}>No</option></select></label>`+btn('Save participation')):''}
 <details class="crew-details"><summary>The crew · ${parts.filter(p=>p.status==='in').length} participating</summary><p><small>Participating: ${parts.filter(p=>p.status==='in').map(p=>name(p.user_id)).join(', ')||'No one yet'}<br>Sitting out: ${parts.filter(p=>p.status==='out').map(p=>name(p.user_id)).join(', ')||'No one'}<br>Not responded: ${s.users.filter(u=>!parts.some(p=>p.user_id===u.id)).map(u=>name(u.id)).join(', ')||'Everyone has responded'}</small></p></details>
 ${r.phase==='printing'&&mine?.status==='in'?form(base+'entry',input('title','Your build title')+btn('Save entry')):''}
 ${entries.map(e=>`<div class="row"><span><strong>${esc(e.title)}</strong><br><small>by ${name(e.user_id)}</small></span></div>`).join('')}
 ${s.winners.filter(w=>w.round_id===r.id).map(w=>{const e=entries.find(e=>e.id===w.entry_id);return e?`<div class="award">${trophyImage}<strong>${esc(w.category)}</strong><br>${name(e.user_id)} · ${esc(e.title)}</div>`:'';}).join('')}
 ${printLinks(r,mine)}
 ${controls?`<div class="round-controls"><p class="eyebrow">ORGANIZER CONTROLS</p>${controls}</div>`:''}</section>`;
}
root.addEventListener('submit',async e=>{
 e.preventDefault();const f=e.target,b=e.submitter||f.querySelector('button:not([type="button"])');if(f.dataset.google)return;b.disabled=true;
 try{
  if(f.hasAttribute('data-invite-gate')){await checkInvitation(f.elements.invite.value);return;}
  if(f.dataset.google)return;
  const d=new FormData(f);
  f.querySelectorAll('input[type="datetime-local"]').forEach(field=>{if(field.value&&!field.disabled)d.set(field.name,new Date(field.value).toISOString());});
  if(f.dataset.path==='profile/avatar'&&d.get('file')?.size>2*1024*1024)throw Error('Profile photos must be 2 MB or smaller.');
  if(['admin/demote','admin/reset-password'].includes(f.dataset.path)&&!window.confirm(f.dataset.path==='admin/demote'?'Remove admin access from this member?':'Generate a temporary password for this member? Any previous temporary password will stop working.'))return;
  if(/^admin\/invitations\/\d+\/revoke$/.test(f.dataset.path)&&!window.confirm('Revoke this invitation? Its code and signup link will stop accepting new members. Existing accounts will not be affected.'))return;
  if(f.dataset.path.endsWith('/delete-competition')&&!window.confirm('Permanently delete “'+f.closest('.round-card').querySelector('h2').textContent+'” and all its topics, votes, entries, results and print links? This cannot be undone.'))return;
  const out=await post(f.dataset.path,f.querySelector('[type=file]')?d:Object.fromEntries(d));
  await load();document.querySelector('#message').textContent='Saved.';
  if(f.dataset.path==='auth/reset-password')document.querySelector('#message').textContent='Password changed. Sign in with your new password.';
  if(out.temporary_password){const target=document.querySelector('#temporary-password');target.hidden=false;target.replaceChildren();const note=document.createElement('p');note.textContent='Temporary password for member #'+d.get('member_id')+'. Copy and share privately. It works once and expires in 24 hours. On the sign-in page, choose “Have a temporary password from an admin?” to set a new password.';const field=document.createElement('input');field.readOnly=true;field.value=out.temporary_password;field.setAttribute('aria-label','Temporary password');target.append(note,field);}
  if(out.code){document.querySelector('#invite').textContent=out.id?'Invitation #'+out.id+' ready · '+(out.max_uses===null?'Reusable by multiple people':'One-time use')+' · '+(out.expires_at?'Expires '+dateLabel(out.expires_at):'No expiry')+'.':'One-time invitation ready.';document.querySelector('#invite-code').value=out.code;const link=document.querySelector('#invite-link');if(link){link.value=location.origin+(window.LEAGUE_CONFIG?.basePath||'/')+'#join='+encodeURIComponent(out.code);document.querySelector('#invite-share').hidden=false;}}
  if(out.recovery_codes){const target=document.querySelector('#recovery-codes');target.hidden=false;target.textContent=out.recovery_codes.join('\n');document.querySelector('#message').textContent='Save these recovery codes privately. Each works once.';}
 }catch(err){document.querySelector('#message').textContent=err.message;}finally{b.disabled=false;}
});
root.addEventListener('click',e=>{
 const toggle=e.target.closest('.password-toggle');if(!toggle)return;
 const field=toggle.parentElement.querySelector('input');const visible=field.type==='password';
 field.type=visible?'text':'password';toggle.setAttribute('aria-label',visible?'Hide password':'Show password');toggle.setAttribute('aria-pressed',String(visible));
});
root.addEventListener('click',e=>{const page=e.target.closest('[data-page]');if(page&&!page.disabled){archivePage=Number(page.dataset.page);render();}});
root.addEventListener('change',e=>{
 if(e.target.form)e.target.form.dataset.dirty='true';
 if(e.target.name==='prevote'){
  const field=e.target.form.elements.vote_opens_at;field.disabled=!e.target.checked;field.closest('label').hidden=!e.target.checked;if(!e.target.checked)field.value='';
 }
});
document.querySelector('#logout').onclick=async()=>{try{await post('auth/logout',{});joinState={code:'',verified:false,googleAllowed:true,method:'password'};lastInviteLink='';document.querySelector('#settings').open=false;location.hash='';await load();document.querySelector('#message').textContent='Signed out.';}catch(err){document.querySelector('#message').textContent=err.message;}};
window.addEventListener('hashchange',()=>{document.querySelector('#settings').open=false;document.querySelector('#message').textContent='';if(s){if(location.hash==='#admin')load().catch(e=>document.querySelector('#message').textContent=e.message);else render();}});
document.addEventListener('click',e=>{if(!e.target.closest('#settings'))document.querySelector('#settings').open=false;});
document.addEventListener('keydown',e=>{if(e.key==='Escape'){document.querySelector('#settings').open=false;document.querySelector('#settings summary').focus();}});
let availabilityTimer;
root.addEventListener('input',e=>{
 if(e.target.form)e.target.form.dataset.dirty='true';
 if(e.target.name==='confirm_password'||e.target.name==='password'){
  const f=e.target.form, confirm=f.elements.confirm_password;
  if(confirm)confirm.setCustomValidity(confirm.value&&confirm.value!==f.elements.password.value?'Passwords do not match.':'');
 }
 if(!e.target.matches('[data-check-username]'))return;
 const field=e.target,status=field.parentElement.querySelector('.username-status'),value=field.value.trim();
 clearTimeout(availabilityTimer);field.setCustomValidity('');status.textContent=value?'Checking availability…':field.required?'Enter a username.':'Leave blank to generate from your Gmail name.';updateGoogleSignup(field.form);
 if(!value)return;
 availabilityTimer=setTimeout(async()=>{try{
  const out=await window.leagueAPI.request('username-availability?name='+encodeURIComponent(value));
  if(!field.isConnected||field.value.trim()!==value)return;
  status.textContent=out.available?'This username is available.':'That username is already taken (including capitalization variants).';
  field.setCustomValidity(out.available?'':'That username is already taken.');updateGoogleSignup(field.form);
 }catch(err){if(field.isConnected&&field.value.trim()===value)status.textContent='Availability will be checked when you save.';}},300);
});
load().catch(e=>document.querySelector('#message').textContent=e.message);
setInterval(tickClocks,1000);
let refreshing=false;
setInterval(async()=>{
 if(!s?.user||document.visibilityState!=='visible'||refreshing)return;
 // Preserve unfinished forms while checking deadlines and vote changes.
 if(document.querySelector('#temporary-password:not([hidden])')||document.querySelector('#invite-share:not([hidden])')||document.querySelector('[data-google-button]:not(:empty)')||document.querySelector('#recovery-codes:not([hidden])')||root.querySelector('form[data-dirty]')||root.contains(document.activeElement)&&document.activeElement.closest('form'))return;
 refreshing=true;
 try{
  const next=await readState();serverOffset=(next.server_now*1000)-Date.now();
  const changed=JSON.stringify({...s,server_now:0})!==JSON.stringify({...next,server_now:0});s=next;if(changed)render();
 }catch{}finally{refreshing=false;}
},10000);
