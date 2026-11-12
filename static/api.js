/* Flask uses same-origin cookies locally. Pages stores its opaque bearer session
   in this tab so reloads work; passwords are never persisted. */
(() => {
 const config = window.LEAGUE_CONFIG;
 const storageKey=config?'print-league:session:'+config.apiBase:null;
 const validToken=token=>typeof token==='string'&&/^[a-f0-9]{64}$/.test(token);
 let sessionToken=null;
 try{const saved=storageKey&&window.sessionStorage?.getItem(storageKey);if(validToken(saved))sessionToken=saved;else if(storageKey)window.sessionStorage?.removeItem(storageKey);}catch{}
 function setSession(token){
  sessionToken=validToken(token)?token:null;
  try{if(storageKey){if(sessionToken)window.sessionStorage?.setItem(storageKey,sessionToken);else window.sessionStorage?.removeItem(storageKey);}}catch{}
 }
 window.leagueAPI = {
  setSession,
  async image(id) {
   const requestToken=sessionToken;
   const response=await fetch((config?config.apiBase:'/api/')+'users/'+encodeURIComponent(id)+'/avatar',{headers:config&&sessionToken?{Authorization:'Bearer '+sessionToken}:{},credentials:config?'omit':'same-origin',redirect:'error'});
   if(config&&response.status===401&&sessionToken===requestToken)setSession(null);
   if(!response.ok||!response.headers.get('Content-Type')?.startsWith('image/'))throw Error('Photo unavailable.');
   return response.blob();
  },
  async request(path, options = {}) {
   if (!/^[a-zA-Z0-9][a-zA-Z0-9/_?=&%+.-]*$/.test(path) || path.split('/').includes('..')) throw Error('Invalid API path');
   const requestToken=sessionToken;
   const headers = {...options.headers};
   if (config && sessionToken) headers.Authorization = 'Bearer ' + sessionToken;
   const response = await fetch((config ? config.apiBase : '/api/') + path, {
    ...options, headers, credentials:config ? 'omit' : 'same-origin', redirect:'error'
   });
   if (!(response.headers.get('content-type') || '').includes('application/json')) throw Error('The league API is not available yet. Please try again later.');
   const data = await response.json();
   if (!response.ok) { if(config && response.status===401&&sessionToken===requestToken)setSession(null); const error=Error(data.error || 'Request failed');error.code=data.code;error.status=response.status;throw error; }
   if (config && typeof data.session_token === 'string') setSession(data.session_token);
   if (path === 'auth/logout') setSession(null);
   return data;
  }
 };
})();
