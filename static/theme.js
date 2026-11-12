(() => {
  const key='print-league-theme',motionKey='print-league-benchy-motion';
  const valid=['system','light','dark','benchy'];
  const systemTheme=window.matchMedia?.('(prefers-color-scheme: dark)');
  let saved,animate=true;
  try{saved=localStorage.getItem(key);animate=localStorage.getItem(motionKey)!=='off';}catch{}
  let theme=valid.includes(saved)?saved:'system';
  const resolvedTheme=()=>theme==='system'?(systemTheme?.matches?'dark':'light'):theme;
  const html=document.documentElement;
  html.dataset.theme=resolvedTheme();
  html.dataset.rainPaused=String(!animate);
  document.addEventListener('DOMContentLoaded',()=>{
    const choice=document.querySelector('#theme-choice'),motion=document.querySelector('#rain-motion'),setting=document.querySelector('#rain-setting');
    if(!choice || !motion || !setting)return;
    let rain;
    function createRain(){
      if(rain)return;
      rain=document.createElement('div');rain.id='benchy-rain';rain.setAttribute('aria-hidden','true');
      const colors=['#f2b45e','#65b8ef','#b391e6','#58c6b5','#ef8cae','#e5dbb8'];
      for(let i=0;i<26;i++){
        const drop=document.createElement('span');drop.className='benchy-drop';
        drop.innerHTML='<svg viewBox="0 0 128 108" aria-hidden="true"><use href="/static/assets/benchy.svg#boat"/></svg>';
        drop.style.left=`${(i*37.7)%100}%`;
        drop.style.width=`${25+(i*13)%34}px`;
        drop.style.color=colors[i%colors.length];
        drop.style.animationDuration=`${17+(i*7)%18}s`;
        drop.style.animationDelay=`-${(i*3.71)%34}s`;
        drop.style.setProperty('--tilt',`${(i*17)%60-30}deg`);
        drop.style.setProperty('--drift',`${(i%2?1:-1)*(25+i%5*12)}px`);
        drop.style.setProperty('--flip',i%4===0?'-1':'1');
        rain.append(drop);
      }
      document.body.prepend(rain);
    }
    function apply(){
      html.dataset.theme=resolvedTheme();html.dataset.rainPaused=String(!animate);
      choice.value=theme;motion.checked=animate;setting.hidden=theme!=='benchy';
      if(theme==='benchy')createRain();
      if(rain)rain.hidden=theme!=='benchy';
    }
    choice.addEventListener('change',()=>{
      if(!valid.includes(choice.value))return;
      theme=choice.value;apply();try{localStorage.setItem(key,theme);}catch{}
    });
    motion.addEventListener('change',()=>{
      animate=motion.checked;apply();try{localStorage.setItem(motionKey,animate?'on':'off');}catch{}
    });
    if(systemTheme?.addEventListener)systemTheme.addEventListener('change',()=>{if(theme==='system')apply();});
    else if(systemTheme?.addListener)systemTheme.addListener(()=>{if(theme==='system')apply();});
    document.addEventListener('visibilitychange',()=>{html.dataset.pageHidden=String(document.hidden);});
    apply();
  });
})();
