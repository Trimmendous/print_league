/* Flask uses same-origin cookies locally. Pages uses explicit bearer sessions,
   with no third-party cookies or credentials persisted to browser storage. */
(() => {
 const config = window.LEAGUE_CONFIG;
 let sessionToken = null;
 window.leagueAPI = {
  setSession(token) { sessionToken = typeof token === 'string' ? token : null; },
  async image(id) {
   const response=await fetch((config?config.apiBase:'/api/')+'users/'+encodeURIComponent(id)+'/avatar',{headers:config&&sessionToken?{Authorization:'Bearer '+sessionToken}:{},credentials:config?'omit':'same-origin',redirect:'error'});
   if(!response.ok||!response.headers.get('Content-Type')?.startsWith('image/'))throw Error('Photo unavailable.');
   return response.blob();
  },
  async request(path, options = {}) {
   if (!/^[a-zA-Z0-9][a-zA-Z0-9/_?=&%+.-]*$/.test(path) || path.split('/').includes('..')) throw Error('Invalid API path');
   const headers = {...options.headers};
   if (config && sessionToken) headers.Authorization = 'Bearer ' + sessionToken;
   const response = await fetch((config ? config.apiBase : '/api/') + path, {
    ...options, headers, credentials:config ? 'omit' : 'same-origin', redirect:'error'
   });
   if (!(response.headers.get('content-type') || '').includes('application/json')) throw Error('The league API is not available yet. Please try again later.');
   const data = await response.json();
   if (!response.ok) { if(config && response.status===401) sessionToken=null; throw Error(data.error || 'Request failed'); }
   if (config && typeof data.session_token === 'string') sessionToken = data.session_token;
   if (path === 'auth/logout') sessionToken = null;
   return data;
  }
 };
})();
