'use strict';
document.getElementById('sandbox-start')?.addEventListener('click', async event => {
  const button=event.currentTarget, state=document.getElementById('sandbox-state');
  button.disabled=true;
  try {
    const response=await fetch('/api/sandbox/session',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:'{}'});
    const data=await response.json();
    if(!response.ok||!data.ok)throw new Error(data.error||'Test session could not be created.');
    location.assign('/pricing');
  }catch(error){state.textContent=error.message;button.disabled=false;}
});
