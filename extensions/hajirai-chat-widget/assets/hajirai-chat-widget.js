(function(){
'use strict';

/* Visual config comes from theme editor (liquid-injected as window.__AI_CHAT_CONFIG).
   Chat server URL is handled internally via app proxy at /apps/hajirai/chat. */
var C=window.__AI_CHAT_CONFIG||{};

/* Apply merchant colors as CSS variables (overrides theme block defaults). */
var _rootStyle=document.documentElement.style;
if(C.colorPrimary) _rootStyle.setProperty('--ai-chat-color-primary', C.colorPrimary);
if(C.colorAccent)  _rootStyle.setProperty('--ai-chat-color-accent',  C.colorAccent);
if(C.colorCtaBg)   _rootStyle.setProperty('--ai-chat-cta-bg',        C.colorCtaBg);
if(C.colorCtaText) _rootStyle.setProperty('--ai-chat-cta-text',      C.colorCtaText);
if(C.colorCtaHover)_rootStyle.setProperty('--ai-chat-cta-hover',     C.colorCtaHover);

var CHAT_URL='/apps/hajirai/chat';
var FEEDBACK_URL='/apps/hajirai/feedback';
var CONFIG_URL='/apps/hajirai/widget-config';
var HRK='hajirai_hide_rules';

function matchesHideRule(rules){
  if(!rules||!rules.length)return false;
  var path=window.location.pathname;
  for(var i=0;i<rules.length;i++){
    var r=rules[i];
    if(r.matchType==='equals'&&path===r.pattern)return true;
    if(r.matchType==='contains'&&path.indexOf(r.pattern)!==-1)return true;
  }
  return false;
}

var _cachedRules=null;
try{_cachedRules=JSON.parse(sessionStorage.getItem(HRK))}catch(e){}
if(_cachedRules&&matchesHideRule(_cachedRules))return;

fetch(CONFIG_URL).then(function(r){return r.json()}).then(function(d){
  if(d.klaviyoFormId)KLAVIYO_FORM_ID=d.klaviyoFormId;
  if(d.klaviyoCompanyId)KLAVIYO_COMPANY_ID=d.klaviyoCompanyId;
  if(d.klaviyoListId)KLAVIYO_LIST_ID=d.klaviyoListId;
  if(d.showLoginPill===false){
    SHOW_LOGIN_PILL=false;
    var pill=document.querySelector('.ai-chat-header__login-pill,.ai-chat-header__vip-pill');
    if(pill)pill.style.display='none';
  }
  var rules=d.hideOnUrls||[];
  try{sessionStorage.setItem(HRK,JSON.stringify(rules))}catch(e){}
  if(matchesHideRule(rules)){
    var l=document.querySelector('.ai-chat-launcher');
    var p=document.querySelector('.ai-chat-panel');
    var o=document.querySelector('.ai-chat-overlay');
    if(l)l.style.display='none';
    if(p)p.style.display='none';
    if(o)o.style.display='none';
  }
}).catch(function(){});
var SHOP=C.shopDomain||'';
var GREET=C.greeting||'Hi! I\'m your personal shopping assistant.';
var GREET_LOGGED=C.greetingLoggedIn||'';
var GREETCTA=C.greetingCta||'What can I help you find today?';
var AVATAR=C.avatarUrl||'';
var BANNER=C.bannerUrl||'';
var NAME=C.assistantName||'AI Shopping Assistant';
var TAG=C.assistantTagline||'';
var LPLACE=C.launcherPlaceholder||'How can I help you today?';
var IPLACE=C.inputPlaceholder||'How can I help you today?';
var POS=C.widgetPosition||'bottom-center';
var CTA1L=C.cta1Label||'';var CTA1M=C.cta1Message||'';
var CTA2L=C.cta2Label||'';var CTA2M=C.cta2Message||'';
var CTA3L=C.cta3Label||'';var CTA3M=C.cta3Message||'';
var CTA4L=C.cta4Label||'';var CTA4M=C.cta4Message||'';
var HINT=C.ctaHint||'';
var HINT_LOGGED=C.ctaHintLoggedIn||'';
var QP1L=C.quickPick1Label||'';var QP1M=C.quickPick1Message||'';
var QP2L=C.quickPick2Label||'';var QP2M=C.quickPick2Message||'';
var QP3L=C.quickPick3Label||'';var QP3M=C.quickPick3Message||'';
var QP4L=C.quickPick4Label||'';var QP4M=C.quickPick4Message||'';
var SHOWBAN=C.showBanner!==false;
var DISCL=C.disclaimerText||'';
var PRIVURL=C.privacyUrl||'/pages/privacy-policy';
var LWIDTH=C.launcherWidth||'500';
var CWIDTH=C.chatWidth||LWIDTH;
var HIDE_MOBILE=C.hideOnMobile===true;
var SUPPORT_URL=C.supportUrl||'';
var SUPPORT_LABEL=C.supportLabel||'Contact customer service';
var CUST_LOGGED_IN=C.customerLoggedIn===true;
var CUST_NAME=C.customerFirstName||'';
var CUST_ID=C.customerId||null;
var CUST_LOGIN_URL=C.customerLoginUrl||'/account/login';
var SHOW_LOGIN_PILL=true;
var KLAVIYO_FORM_ID='';
var KLAVIYO_COMPANY_ID='';
var KLAVIYO_LIST_ID='';
var SK='hajirai_chat_session';
var HK='hajirai_chat_history';

function $(s,c){return(c||document).querySelector(s)}
function el(t,cl,h){var e=document.createElement(t);if(cl)e.className=cl;if(h)e.innerHTML=h;return e}
function esc(s){var d=document.createElement('div');d.appendChild(document.createTextNode(s));return d.innerHTML}
function fmt(c){return'$'+(c/100).toFixed(2)}
function safeUrl(u){var s=String(u||'').trim();return /^(https?:\/\/|\/)/i.test(s)?s.replace(/"/g,'&quot;'):''}
function md(t){if(!t)return'';return t.replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>').replace(/\*(.+?)\*/g,'<em>$1</em>').replace(/\[([^\]]+)\]\(([^)]+)\)/g,function(_,txt,url){var u=safeUrl(url);return u?'<a href="'+u+'" target="_blank" rel="noopener">'+txt+'</a>':txt}).replace(/^[-*] (.+)$/gm,'<li>$1</li>').replace(/(<li>.*<\/li>)/gs,'<ul>$1</ul>').replace(/\n{2,}/g,'</p><p>').replace(/\n/g,'<br>')}

function getSess(){var id=localStorage.getItem(SK);if(!id){id='sess_'+Date.now()+'_'+Math.random().toString(36).slice(2,10);localStorage.setItem(SK,id)}return id}
function saveH(m){try{localStorage.setItem(HK,JSON.stringify(m.slice(-50)))}catch(e){}}
function loadH(){try{return JSON.parse(localStorage.getItem(HK))||[]}catch(e){return[]}}

function addToCart(vid,qty){
return fetch('/cart/add.js',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({items:[{id:parseInt(vid,10),quantity:qty||1}]})}).then(function(r){return r.json()}).then(function(d){document.dispatchEvent(new CustomEvent('cart:refresh'));return fetch('/cart.js').then(function(r){return r.json()}).then(function(cart){document.querySelectorAll('[data-cart-count],.cart-count,.header__cart-count').forEach(function(e){e.textContent=cart.item_count});return d})})
}

var avatarImg=AVATAR?'<img src="'+AVATAR+'" alt="'+esc(NAME)+'">':'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
var assistantBubbleAvatar=AVATAR?'<img src="'+AVATAR+'" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%">':'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';

/* Build launcher */
var launcher=el('div','ai-chat-launcher ai-chat-launcher--'+POS);
launcher.style.width=LWIDTH+'px';
launcher.style.maxWidth='calc(100vw - 32px)';
launcher.innerHTML='<div class="ai-chat-launcher__icon">'+avatarImg+'</div><span class="ai-chat-launcher__text">'+esc(LPLACE)+'</span><button class="ai-chat-launcher__send" aria-label="Open chat"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg></button><button class="ai-chat-launcher__close" aria-label="Dismiss"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>';

/* Build panel */
var panel=el('div','ai-chat-panel ai-chat-panel--'+POS);
var panelW=Math.max(parseInt(CWIDTH)||parseInt(LWIDTH)||500,360);
panel.style.width=panelW+'px';
panel.style.maxWidth='calc(100vw - 16px)';
panel.setAttribute('role','dialog');
panel.setAttribute('aria-label','AI Shopping Assistant');

var headerAv=AVATAR?'<div class="ai-chat-header__avatar"><img src="'+AVATAR+'" alt="'+esc(NAME)+'"></div>':'<div class="ai-chat-header__avatar ai-chat-header__avatar--placeholder"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg></div>';

var loginPillHtml='';
if(CUST_LOGGED_IN&&CUST_NAME){
  loginPillHtml='<span class="ai-chat-header__vip-pill" title="Logged in">Hi '+esc(CUST_NAME)+'!</span>';
}else if(!CUST_LOGGED_IN){
  loginPillHtml='<a class="ai-chat-header__login-pill" href="'+esc(CUST_LOGIN_URL)+'">Login</a>';
}

panel.innerHTML=
'<div class="ai-chat-header">'+headerAv+'<div class="ai-chat-header__info"><div class="ai-chat-header__name">'+esc(NAME)+'</div></div><div class="ai-chat-header__actions">'+loginPillHtml+'<button class="ai-chat-header__btn ai-chat-menu-btn" aria-label="Menu" title="Options"><svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg></button><button class="ai-chat-header__btn ai-chat-close-btn" aria-label="Close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button></div></div>'+
'<div class="ai-chat-messages" role="log" aria-live="polite"></div>'+
'<div class="ai-chat-typing"><div class="ai-chat-msg-avatar">'+assistantBubbleAvatar+'</div><div class="ai-chat-typing-dots"><span class="ai-chat-typing-dot"></span><span class="ai-chat-typing-dot"></span><span class="ai-chat-typing-dot"></span></div><span class="ai-chat-typing-text" aria-live="polite"></span></div>'+
'<div class="ai-chat-input-area"><div class="ai-chat-input-wrap"><div class="ai-chat-input-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg></div><textarea class="ai-chat-input" rows="1" placeholder="'+esc(IPLACE)+'" aria-label="Type your message"></textarea></div><button class="ai-chat-send" aria-label="Send"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg></button></div>'+
(DISCL?'<div class="ai-chat-footer">'+esc(DISCL)+' <a href="'+esc(PRIVURL)+'">Privacy Policy</a></div>':'');

/* Build overlay */
var overlay=el('div','ai-chat-overlay');

/* Menu dropdown */
var menu=el('div','ai-chat-menu');
menu.style.cssText='position:absolute;top:52px;right:12px;background:#fff;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.15);z-index:10;display:none;min-width:140px;overflow:hidden';
menu.innerHTML='<button class="ai-chat-menu-item" data-action="clear" style="display:block;width:100%;padding:10px 16px;border:none;background:none;text-align:left;font-size:13px;cursor:pointer;color:#1a1a1a;font-family:inherit">Clear Chat</button>';
panel.style.position='fixed';
panel.appendChild(menu);

document.body.appendChild(overlay);
document.body.appendChild(panel);
document.body.appendChild(launcher);

/* Hide on mobile if configured */
var isMobileHidden=false;
function checkMobileHide(){
  if(!HIDE_MOBILE)return;
  var mobile=window.innerWidth<768;
  if(mobile&&!isMobileHidden){
    launcher.style.display='none';
    panel.style.display='none';
    overlay.style.display='none';
    isMobileHidden=true;
  }else if(!mobile&&isMobileHidden){
    launcher.style.display='';
    panel.style.display='';
    overlay.style.display='';
    isMobileHidden=false;
  }
}
checkMobileHide();
window.addEventListener('resize',checkMobileHide);

/* Custom launcher: any element with data-open-ai-chat opens the chatbot */
document.addEventListener('click',function(e){
  var trigger=e.target.closest('[data-open-ai-chat]');
  if(!trigger)return;
  e.preventDefault();
  if(isMobileHidden){
    launcher.style.display='';panel.style.display='';overlay.style.display='';isMobileHidden=false;
  }
  if(typeof toggle==='function')toggle(true);
});

/* Cache refs */
var msgsEl=$('.ai-chat-messages',panel);
var typingEl=$('.ai-chat-typing',panel);
var typingTextEl=$('.ai-chat-typing-text',panel);
var inputEl=$('.ai-chat-input',panel);
var sendBtn=$('.ai-chat-send',panel);
var closeBtn=$('.ai-chat-close-btn',panel);
var menuBtn=$('.ai-chat-menu-btn',panel);

/* Typing hint rotator — shows reassuring text after 4s, rotates every 4s */
var TYPING_HINTS=['Still looking…','Almost there…','Just a moment…','Thanks for your patience…'];
var typingHintTimer=null,typingHintIdx=0;
function clearTypingHints(){
  if(typingHintTimer){clearTimeout(typingHintTimer);typingHintTimer=null}
  typingHintIdx=0;
  if(typingTextEl){typingTextEl.textContent='';typingTextEl.classList.remove('visible')}
}
function scheduleTypingHint(delay){
  typingHintTimer=setTimeout(function tick(){
    if(!typingEl.classList.contains('visible')){clearTypingHints();return}
    if(typingTextEl){
      typingTextEl.textContent=TYPING_HINTS[typingHintIdx%TYPING_HINTS.length];
      typingTextEl.classList.add('visible');
    }
    typingHintIdx++;
    typingHintTimer=setTimeout(tick,4000);
  },delay);
}
try{
  var typingObserver=new MutationObserver(function(){
    if(typingEl.classList.contains('visible')){clearTypingHints();scheduleTypingHint(4000)}
    else{clearTypingHints()}
  });
  typingObserver.observe(typingEl,{attributes:true,attributeFilter:['class']});
}catch(e){}

var isOpen=false,isStreaming=false,messages=loadH(),abortCtrl=null;
var lastUserMessage='',errorRetryCount=0;
var IDLE_TIMEOUT=5*60*1000;
var LMK='hajirai_chat_last_msg';
var idleTimedOut=false;
function stampLastMsg(){try{localStorage.setItem(LMK,''+Date.now())}catch(e){}}
function getLastMsg(){try{return parseInt(localStorage.getItem(LMK),10)||0}catch(e){return 0}}
function clearLastMsg(){try{localStorage.removeItem(LMK)}catch(e){}}
function checkIdleOnOpen(){
  if(messages.length===0||idleTimedOut)return;
  var last=getLastMsg();
  if(last&&(Date.now()-last)>=IDLE_TIMEOUT){
    showIdleTimeout();
  }
}
function showIdleTimeout(){
  if(idleTimedOut||isStreaming||messages.length===0)return;
  idleTimedOut=true;
  var txt="It looks like you've been away for a bit. Would you like to continue or start fresh?";
  messages.push({role:'assistant',content:txt});
  var md=appendMsg('assistant',txt);
  var bb=$('.ai-chat-msg-bubble',md);
  if(bb)bb.insertAdjacentHTML('beforeend',deadEndHtml());
  inputEl.disabled=true;inputEl.placeholder='Choose an option above';sendBtn.disabled=true;
  saveH(messages);scrollBottom();
}

function buildWelcome(){
var h='<div class="ai-chat-welcome">';
if(SHOWBAN){
  h+='<div class="ai-chat-welcome__banner">';
  if(BANNER)h+='<img src="'+BANNER+'" alt="">';
  h+='</div>';
}
h+='<div class="ai-chat-welcome__avatar">'+avatarImg+'</div>';
h+='<div class="ai-chat-welcome__name">'+esc(NAME)+'</div>';
var welcomeGreeting=(CUST_LOGGED_IN&&CUST_NAME&&GREET_LOGGED&&GREET_LOGGED.trim())
  ? GREET_LOGGED.replace(/\{name\}/gi,CUST_NAME)
  : GREET;
h+='<div class="ai-chat-welcome__tagline">'+esc(welcomeGreeting)+'</div>';
if(GREETCTA)h+='<div class="ai-chat-welcome__greeting-cta">'+esc(GREETCTA)+'</div>';
var ctas=[];
if(CTA1L&&CTA1M)ctas.push({l:CTA1L,m:CTA1M});
if(CTA2L&&CTA2M)ctas.push({l:CTA2L,m:CTA2M});
if(CTA3L&&CTA3M)ctas.push({l:CTA3L,m:CTA3M});
if(CTA4L&&CTA4M)ctas.push({l:CTA4L,m:CTA4M});
if(ctas.length){
  h+='<div class="ai-chat-welcome__ctas">';
  for(var i=0;i<ctas.length;i++){
    h+='<button class="ai-chat-welcome__cta-btn" data-message="'+esc(ctas[i].m)+'"><span class="cta-plus">+</span> '+esc(ctas[i].l)+'</button>';
  }
  h+='</div>';
}
/* Quick picks */
var qps=[];
if(QP1L&&QP1M)qps.push({l:QP1L,m:QP1M});
if(QP2L&&QP2M)qps.push({l:QP2L,m:QP2M});
if(QP3L&&QP3M)qps.push({l:QP3L,m:QP3M});
if(QP4L&&QP4M)qps.push({l:QP4L,m:QP4M});
if(qps.length){
  h+='<div class="ai-chat-welcome__quickpicks"><span class="ai-chat-welcome__qp-label">Quick picks:</span>';
  for(var j=0;j<qps.length;j++){
    h+='<button class="ai-chat-welcome__qp-btn" data-message="'+esc(qps[j].m)+'">'+esc(qps[j].l)+'</button>';
  }
  h+='</div>';
}
if(CUST_LOGGED_IN){
  if(HINT_LOGGED&&HINT_LOGGED.trim()){
    var loggedHint=HINT_LOGGED.replace(/\{name\}/gi,CUST_NAME||'');
    h+='<div class="ai-chat-welcome__hint">'+esc(loggedHint)+'</div>';
  }
}else if(HINT){
  h+='<a class="ai-chat-welcome__hint ai-chat-welcome__hint--link" href="'+esc(CUST_LOGIN_URL)+'">'+esc(HINT)+'</a>';
}
h+='</div>';
msgsEl.innerHTML=h;
}

function toggle(force){
isOpen=typeof force==='boolean'?force:!isOpen;
if(isOpen){
  launcher.classList.add('hidden');
  panel.classList.add('open');
  overlay.classList.add('visible');
  document.body.classList.add('ai-chat-blurred');
  setTimeout(function(){inputEl.focus()},400);
  setTimeout(function(){inputEl.focus()},800);
  checkIdleOnOpen();
}else{
  panel.classList.remove('open');
  overlay.classList.remove('visible');
  launcher.classList.remove('hidden');
  document.body.classList.remove('ai-chat-blurred');
  menu.style.display='none';
}
}

function scrollBottom(){requestAnimationFrame(function(){msgsEl.scrollTop=msgsEl.scrollHeight})}

function appendMsg(role,content,products){
var isU=role==='user';
var d=el('div','ai-chat-msg ai-chat-msg--'+role);
var av=isU?'<span>You</span>':assistantBubbleAvatar;
d.innerHTML='<div class="ai-chat-msg-avatar">'+av+'</div><div class="ai-chat-msg-bubble"><p>'+md(esc(content))+'</p></div>';
if(products&&products.length){
  var b=$('.ai-chat-msg-bubble',d);
  var ph='<div class="ai-chat-products">';
  for(var i=0;i<products.length;i++)ph+=prodCard(products[i]);
  ph+='</div>';
  b.insertAdjacentHTML('beforeend',ph);
}
msgsEl.appendChild(d);
scrollBottom();
return d;
}

function prodCard(p){
var img=p.image||p.featured_image||'';
var t=esc(p.title||'');
var u=p.url||(p.handle?('/products/'+p.handle):'#');
var pr=esc(p.price_formatted||(p.price?fmt(p.price):''));
var cp=p.compare_at_price?esc(fmt(p.compare_at_price)):'';
var ariaParts=[t];if(pr)ariaParts.push(pr);var ariaLabel=esc(ariaParts.join(' — '));
return '<a class="ai-chat-product-card" data-handle="'+esc(p.handle||'')+'" href="'+esc(u)+'" aria-label="'+ariaLabel+'" style="text-decoration:none;color:inherit">'+(img?'<div class="ai-chat-product-img"><img src="'+esc(img)+'" alt="" loading="lazy"></div>':'')+'<div class="ai-chat-product-info"><span class="ai-chat-product-title">'+t+'</span><div class="ai-chat-product-price">'+pr+(cp?'<span class="compare-at">'+cp+'</span>':'')+'</div></div></a>';
}

function sendMessage(){
var text=inputEl.value.trim();
if(!text||isStreaming)return;
var w=$('.ai-chat-welcome',msgsEl);
if(w)w.remove();
lastUserMessage=text;
messages.push({role:'user',content:text});
appendMsg('user',text);
saveH(messages);
inputEl.value='';inputEl.style.height='auto';
sendBtn.disabled=true;isStreaming=true;
typingEl.classList.add('visible');
scrollBottom();
stampLastMsg();
streamResponse(text);
}

function deadEndHtml(){
var s='<div class="ai-chat-dead-end">';
s+='<button class="ai-chat-dead-end__btn ai-chat-dead-end__btn--support" data-dead-end="support">'+esc(SUPPORT_LABEL)+'</button>';
s+='<button class="ai-chat-dead-end__btn ai-chat-dead-end__btn--new" data-dead-end="new-chat">Start a new chat</button>';
s+='</div>';
return s;
}

function isCreditOrCriticalError(t){return /temporarily unavailable|credit balance|insufficient|billing/i.test(t||'')}
function isRateLimitError(t){return /high traffic|rate limit|getting a lot of/i.test(t||'')}
function retryRowHtml(){return '<div class="ai-chat-retry-row" style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap"><button class="ai-chat-retry-btn" data-retry="1" style="padding:8px 14px;border:1px solid currentColor;background:transparent;color:inherit;border-radius:8px;cursor:pointer;font-size:13px;font-family:inherit">↻ Try again</button></div>'}
// Append either retry button or support escalation to an error bubble.
// 3-strike rule: after 3 errors on the same chain, escalate to support.
// Critical errors (credit/billing) escalate immediately — retry won't help.
function attachErrorRecovery(bubble,errText){
if(!bubble)return;
errorRetryCount++;
var critical=isCreditOrCriticalError(errText);
var rate=isRateLimitError(errText);
if(critical||errorRetryCount>=3||!lastUserMessage){
  bubble.insertAdjacentHTML('beforeend',deadEndHtml());
  inputEl.disabled=true;inputEl.placeholder='Choose an option above';sendBtn.disabled=true;
  return;
}
bubble.insertAdjacentHTML('beforeend',retryRowHtml());
if(rate){
  var btn=bubble.querySelector('.ai-chat-retry-btn');
  if(btn){
    var sec=10;btn.disabled=true;btn.style.opacity='0.6';btn.textContent='Wait '+sec+'s…';
    var iv=setInterval(function(){
      sec--;
      if(sec<=0){clearInterval(iv);btn.textContent='↻ Try again';btn.disabled=false;btn.style.opacity='1';return}
      btn.textContent='Wait '+sec+'s…';
    },1000);
  }
}
}
function showStreamError(em){
isStreaming=false;sendBtn.disabled=false;
typingEl.classList.remove('visible');
var md=appendMsg('assistant',em);
messages.push({role:'assistant',content:em});saveH(messages);
var bb=$('.ai-chat-msg-bubble',md);
attachErrorRecovery(bb,em);
scrollBottom();
}

function showKlaviyoForm(label){
if(!KLAVIYO_COMPANY_ID||!KLAVIYO_LIST_ID)return;
var d=appendMsg('assistant',label||'Stay Connected');
var b=$('.ai-chat-msg-bubble',d);
if(!b)return;
var formHtml='<div class="ai-chat-klaviyo-form" style="margin-top:12px;padding:16px;background:#f8f8f8;border-radius:10px">'
+'<input type="email" class="ai-kl-email" placeholder="Email address" style="display:block;width:100%;padding:10px 12px;border:1px solid #ddd;border-radius:8px;font-size:14px;font-family:inherit;margin-bottom:8px;box-sizing:border-box" />'
+'<input type="tel" class="ai-kl-phone" placeholder="Phone number (optional)" style="display:block;width:100%;padding:10px 12px;border:1px solid #ddd;border-radius:8px;font-size:14px;font-family:inherit;margin-bottom:10px;box-sizing:border-box" />'
+'<button class="ai-kl-submit" style="display:block;width:100%;padding:12px;background:var(--ai-chat-primary,#2d6b4f);color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit">Subscribe</button>'
+'<div class="ai-kl-status" style="font-size:12px;margin-top:8px;text-align:center;display:none"></div>'
+'</div>';
b.insertAdjacentHTML('beforeend',formHtml);
var form=$('.ai-chat-klaviyo-form',b);
var emailIn=$('.ai-kl-email',form);
var phoneIn=$('.ai-kl-phone',form);
var submitBtn=$('.ai-kl-submit',form);
var statusEl=$('.ai-kl-status',form);
submitBtn.addEventListener('click',function(){
  var email=(emailIn.value||'').trim();
  if(!email||email.indexOf('@')===-1){statusEl.style.display='block';statusEl.style.color='#c00';statusEl.textContent='Please enter a valid email.';return}
  submitBtn.disabled=true;submitBtn.textContent='Subscribing...';
  var phone=(phoneIn.value||'').trim();
  var profileAttrs={email:email};
  if(phone)profileAttrs.phone_number=phone;
  fetch('https://a.klaviyo.com/client/subscriptions/?company_id='+encodeURIComponent(KLAVIYO_COMPANY_ID),{
    method:'POST',
    headers:{'Content-Type':'application/json','revision':'2024-10-15'},
    body:JSON.stringify({data:{type:'subscription',attributes:{custom_source:'SEoS Assistant Chat',profile:{data:{type:'profile',attributes:profileAttrs}}},relationships:{list:{data:{type:'list',id:KLAVIYO_LIST_ID}}}}})
  }).then(function(r){
    if(r.ok||r.status===202){
      form.innerHTML='<div style="text-align:center;padding:12px;color:#2d6b4f;font-weight:600;font-size:14px">You\'re subscribed!</div>';
    } else {
      r.text().then(function(t){console.error('[klaviyo] status='+r.status,t)});
      statusEl.style.display='block';statusEl.style.color='#c00';statusEl.textContent='Something went wrong ('+r.status+'). Please try again.';
      submitBtn.disabled=false;submitBtn.textContent='Subscribe';
    }
  }).catch(function(){
    statusEl.style.display='block';statusEl.style.color='#c00';statusEl.textContent='Connection error. Please try again.';
    submitBtn.disabled=false;submitBtn.textContent='Subscribe';
  });
});
scrollBottom();
}

function showHighTraffic(){
showStreamError('I\'m experiencing high traffic right now. Please try again in a moment.');
if(errorRetryCount>=3){setTimeout(function(){showKlaviyoForm('Stay Connected')},500)}
}

var streamWatchdog=null;
function clearWatchdog(){if(streamWatchdog){clearTimeout(streamWatchdog);streamWatchdog=null}}
function streamResponse(msg){
if(abortCtrl)abortCtrl.abort();
clearWatchdog();
abortCtrl=new AbortController();
streamWatchdog=setTimeout(function(){
  if(isStreaming&&abortCtrl){
    try{abortCtrl.abort()}catch(e){}
    showStreamError('This is taking longer than expected. Please try again.');
  }
},90000);
var body={message:msg,session_id:getSess(),shop_domain:SHOP,assistant_name:NAME,history:messages.slice(-20).map(function(m){return{role:m.role,content:m.content}})};
if(SUPPORT_URL)body.support_url=SUPPORT_URL;
if(SUPPORT_LABEL)body.support_label=SUPPORT_LABEL;
fetch(CHAT_URL,{method:'POST',headers:{'Content-Type':'application/json','Accept':'text/event-stream'},body:JSON.stringify(body),signal:abortCtrl.signal}).then(function(r){
if(!r.ok){
  if(r.headers.get('content-type')&&r.headers.get('content-type').includes('text/event-stream'))return handleSSE(r);
  return r.json().catch(function(){return{}}).then(function(d){
    throw new Error(d.message||'Something went wrong. Please try again.');
  });
}
var ct=r.headers.get('content-type')||'';
if(ct.includes('text/event-stream')||ct.includes('text/plain'))return handleSSE(r);
return r.json().then(function(d){handleJSON(d)});
}).catch(function(e){
clearWatchdog();
if(e.name==='AbortError')return;
typingEl.classList.remove('visible');isStreaming=false;sendBtn.disabled=false;
showHighTraffic();
});
}

function handleSSE(response){
var reader=response.body.getReader();
var decoder=new TextDecoder();
var buf='',full='',prods=[],msgDiv=null,buffSugg=[],linkCTA=null,fitReport=null;
function proc(chunk){
buf+=chunk;var lines=buf.split('\n');buf=lines.pop()||'';
for(var i=0;i<lines.length;i++){
var line=lines[i].trim();
if(!line.startsWith('data: '))continue;
var data=line.slice(6);
if(data==='[DONE]'){finish(full,prods,msgDiv,buffSugg,linkCTA,fitReport);return true}
try{
var p=JSON.parse(data);
if(p.type==='text'||p.type==='content_block_delta'){
  var tc=p.text||(p.delta&&p.delta.text)||'';
  full+=tc;
}
if(p.type==='products'&&p.products){
  prods=prods.concat(p.products);
}
if(p.type==='link'&&p.url){
  linkCTA={url:p.url,label:p.label||'Visit Support Hub'};
}
if(p.type==='choices'&&p.options&&p.options.length){
  typingEl.classList.remove('visible');
  if(!msgDiv)msgDiv=appendMsg('assistant',full||'');
  var b=$('.ai-chat-msg-bubble',msgDiv);
  if(b){var ch='<div class="ai-chat-choices">';for(var ci=0;ci<p.options.length;ci++){ch+='<button class="ai-chat-choice-btn" data-message="'+esc(p.options[ci])+'">'+esc(p.options[ci])+'</button>'}ch+='</div>';b.insertAdjacentHTML('beforeend',ch)}
  scrollBottom();
}
if(p.type==='suggestions'&&p.questions&&p.questions.length){
  buffSugg=p.questions;
}
if(p.type==='fit_report'&&p.recommendedSize){
  var _d=p.display==='percent'?'percent':(p.display==='hide'?'hide':'bar');
  fitReport={handle:p.handle||'',productTitle:p.productTitle||'',size:p.recommendedSize,confidence:Math.max(0,Math.min(100,parseInt(p.confidence,10)||0)),reasons:Array.isArray(p.reasons)?p.reasons:[],display:_d};
}
if(p.type==='klaviyo_form'){
  setTimeout(function(){showKlaviyoForm('Stay Connected')},300);
}
if(p.type==='action'&&p.action==='open_zendesk'){
  setTimeout(function(){toggle(false);if(typeof window.zE==='function'){window.zE('webWidget','show');window.zE('webWidget','open')}},1500);
}
if(p.type==='action'&&p.action==='show_dead_end'){
  typingEl.classList.remove('visible');
  if(!msgDiv)msgDiv=appendMsg('assistant','It looks like I\'m having trouble finding what you need.');
  var bubble=$('.ai-chat-msg-bubble',msgDiv);
  if(bubble){
    bubble.insertAdjacentHTML('beforeend',deadEndHtml());
  }
  inputEl.disabled=true;inputEl.placeholder='Choose an option above';sendBtn.disabled=true;
  setTimeout(function(){showKlaviyoForm('Stay Connected')},500);
  scrollBottom();
}
if(p.type==='done'){finish(full,prods,msgDiv,buffSugg,linkCTA,fitReport);return true}
if(p.type==='error'){
  showStreamError(p.message||'I\'m sorry, I\'m having trouble right now. Please try again in a moment.');
  return true;
}
}catch(e){}
}return false}
function read(){reader.read().then(function(r){if(r.done){if(full)finish(full,prods,msgDiv,buffSugg,linkCTA,fitReport);else showStreamError('I\'m having trouble right now. Please try again.');return}var done=proc(decoder.decode(r.value,{stream:true}));if(!done)read()}).catch(function(e){if(e.name!=='AbortError'){if(full)finish(full,prods,msgDiv,buffSugg,linkCTA,fitReport);else showStreamError('Connection lost. Please try again.')}})}
read();
}

function handleJSON(d){
typingEl.classList.remove('visible');
var c=d.message||d.response||d.text||'Sorry, no response. Try again.';
var p=d.products||[];
messages.push({role:'assistant',content:c,products:p});
appendMsg('assistant',c,p);saveH(messages);
isStreaming=false;sendBtn.disabled=false;
}

function fitSnippetHtml(fr){
if(!fr||!fr.size)return '';
var conf=fr.confidence||0;
var confBlock='';
if(fr.display==='percent'){
  confBlock='<div class="ai-chat-product-fit-pct">'+conf+'% sure</div>';
}else if(fr.display!=='hide'){
  confBlock='<div class="ai-chat-product-fit-bar" role="progressbar" aria-valuenow="'+conf+'" aria-valuemin="0" aria-valuemax="100"><div class="ai-chat-product-fit-bar-fill" style="width:'+conf+'%"></div></div><div class="ai-chat-product-fit-pct">'+conf+'% sure</div>';
}
return '<div class="ai-chat-product-fit" aria-label="Size recommendation">'+
  '<span class="ai-chat-product-fit-label">▸ FIT FINDER</span>'+
  '<div class="ai-chat-product-fit-size">Size <strong>'+esc(fr.size)+'</strong></div>'+
  confBlock+
'</div>';
}

function fitReportHtml(fr){
if(!fr||!fr.size)return '';
var conf=fr.confidence||0;
var confBlock='';
if(fr.display!=='hide'){
  var bar=fr.display==='percent'?'<div class="ai-chat-fit-percent">'+conf+'%</div>':'<div class="ai-chat-fit-bar" role="progressbar" aria-valuenow="'+conf+'" aria-valuemin="0" aria-valuemax="100"><div class="ai-chat-fit-bar-fill" style="width:'+conf+'%"></div><span class="ai-chat-fit-bar-val">'+conf+'%</span></div>';
  confBlock='<div class="ai-chat-fit-conf-label">Confidence</div>'+bar;
}
var reasonsHtml='';
if(fr.reasons&&fr.reasons.length){
  reasonsHtml='<ul class="ai-chat-fit-reasons">';
  for(var i=0;i<fr.reasons.length;i++){reasonsHtml+='<li>'+esc(fr.reasons[i])+'</li>'}
  reasonsHtml+='</ul>';
}
var forLine=fr.productTitle?'<div class="ai-chat-fit-for">For <strong>'+esc(fr.productTitle)+'</strong></div>':'';
return '<div class="ai-chat-fit-card" role="region" aria-label="Size recommendation for '+esc(fr.productTitle||'product')+'">'+
  '<div class="ai-chat-fit-head"><span class="ai-chat-fit-icon" aria-hidden="true">▸</span><span class="ai-chat-fit-title">Fit finder</span></div>'+
  forLine+
  '<div class="ai-chat-fit-size">Recommended size <strong>'+esc(fr.size)+'</strong></div>'+
  confBlock+
  reasonsHtml+
'</div>';
}

function finish(text,prods,md2,sugg,linkCTA,fitReport){
clearWatchdog();
typingEl.classList.remove('visible');isStreaming=false;sendBtn.disabled=false;
errorRetryCount=0;
var mDiv=md2;
var choices=[];
var cleanText=text||'';
var choiceRe=/<<([^<>]+)>>/g;
var cm;while((cm=choiceRe.exec(cleanText))!==null){choices.push(cm[1])}
if(choices.length>0)cleanText=cleanText.replace(/\s*<<[^<>]+>>/g,'').trim();
if(cleanText){
  if(!mDiv)mDiv=appendMsg('assistant',cleanText,prods);
  else{var b=$('.ai-chat-msg-bubble',mDiv);if(b){b.innerHTML='<p>'+md(esc(cleanText))+'</p>';if(prods&&prods.length){var ph='<div class="ai-chat-products">';for(var pi=0;pi<prods.length;pi++)ph+=prodCard(prods[pi]);ph+='</div>';b.insertAdjacentHTML('beforeend',ph)}}}
  messages.push({role:'assistant',content:cleanText,products:prods||[]});saveH(messages)
}
if(choices.length>0&&mDiv){
  var cb=$('.ai-chat-msg-bubble',mDiv);
  if(cb){var ch='<div class="ai-chat-choices">';for(var ci=0;ci<choices.length;ci++){ch+='<button class="ai-chat-choice-btn" data-message="'+esc(choices[ci])+'">'+esc(choices[ci])+'</button>'}ch+='</div>';cb.insertAdjacentHTML('beforeend',ch)}
}
if(linkCTA&&linkCTA.url&&mDiv){
  var lb=$('.ai-chat-msg-bubble',mDiv);
  if(lb)lb.insertAdjacentHTML('beforeend','<a class="ai-chat-cta-btn" style="display:block;margin-top:12px;padding:14px 16px;background:var(--ai-chat-primary,#2d6b4f);color:#fff;border-radius:10px;text-decoration:none;text-align:center;font-size:14px;font-weight:600;line-height:1.3" href="'+esc(linkCTA.url)+'" target="_blank" rel="noopener">'+esc(linkCTA.label||'Visit Support Hub')+' &rarr;</a>');
}
if(fitReport&&fitReport.size&&mDiv){
  var frb=$('.ai-chat-msg-bubble',mDiv);
  if(frb){
    var _h=(fitReport.handle||'').replace(/"/g,'');
    var matchProd=_h?frb.querySelector('.ai-chat-product-card[data-handle="'+_h+'"]'):null;
    if(matchProd){
      matchProd.classList.add('has-fit');
      matchProd.insertAdjacentHTML('beforeend',fitSnippetHtml(fitReport));
    }else{
      var tmp=document.createElement('div');
      tmp.innerHTML=fitReportHtml(fitReport);
      var fitEl=tmp.firstChild;
      if(fitEl)frb.appendChild(fitEl);
    }
  }
}
if(sugg&&sugg.length>0&&mDiv){
  var sb=$('.ai-chat-msg-bubble',mDiv);
  if(sb){var sg='<div class="ai-chat-suggestions">';for(var si=0;si<sugg.length;si++){sg+='<button class="ai-chat-suggest-btn" data-message="'+esc(sugg[si])+'"><span class="suggest-plus">+</span> '+esc(sugg[si])+'</button>'}sg+='</div>';sb.insertAdjacentHTML('beforeend',sg)}
}
if(prods&&prods.length>0&&mDiv){
  var fb=$('.ai-chat-msg-bubble',mDiv);
  if(fb&&!$('.ai-chat-feedback',fb)){
    fb.insertAdjacentHTML('beforeend','<div class="ai-chat-feedback"><button class="ai-chat-fb-btn" data-vote="up"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3H14z"/><path d="M7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/></svg> Helpful</button><button class="ai-chat-fb-btn" data-vote="down"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3H10z"/><path d="M17 2h3a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-3"/></svg> Not helpful</button></div>');
    fb.querySelectorAll('.ai-chat-fb-btn').forEach(function(btn){
      btn.addEventListener('click',function(){
        var vote=this.getAttribute('data-vote');
        var wrap=this.closest('.ai-chat-feedback');
        wrap.innerHTML='<span class="ai-chat-fb-thanks">'+(vote==='up'?'Thanks for the feedback!':'Sorry about that, we\'ll improve!')+'</span>';
        var payload={vote:vote,session:getSess(),botResponse:(text||'').slice(0,500),products:(prods||[]).map(function(p){return p.title||''}).slice(0,5)};
        if(vote==='down'){payload.conversation=messages.slice(-10).map(function(m){return{role:m.role,content:(m.content||'').slice(0,300)}})}
        try{fetch(FEEDBACK_URL,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)})}catch(e){}
      });
    });
  }
}
scrollBottom();
}

function clearChat(){
messages=[];localStorage.removeItem(HK);localStorage.removeItem(SK);
msgsEl.innerHTML='';buildWelcome();
if(abortCtrl){abortCtrl.abort();abortCtrl=null}
isStreaming=false;sendBtn.disabled=false;typingEl.classList.remove('visible');
idleTimedOut=false;clearLastMsg();
errorRetryCount=0;lastUserMessage='';
}

/* Events */
launcher.addEventListener('click',function(e){
if(e.target.closest('.ai-chat-launcher__close')){launcher.classList.add('hidden');return}
toggle(true);
});
closeBtn.addEventListener('click',function(){toggle(false)});
overlay.addEventListener('click',function(){toggle(false)});
sendBtn.addEventListener('click',sendMessage);
inputEl.addEventListener('keydown',function(e){if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendMessage()}});
inputEl.addEventListener('input',function(){this.style.height='auto';this.style.height=Math.min(this.scrollHeight,100)+'px'});
document.addEventListener('keydown',function(e){if(e.key==='Escape'&&isOpen)toggle(false)});
menuBtn.addEventListener('click',function(e){e.stopPropagation();menu.style.display=menu.style.display==='none'?'block':'none'});
menu.addEventListener('click',function(e){var item=e.target.closest('[data-action]');if(!item)return;if(item.dataset.action==='clear')clearChat();menu.style.display='none'});
document.addEventListener('click',function(){menu.style.display='none'});
msgsEl.addEventListener('click',function(e){
var retryBtn=e.target.closest('[data-retry]');
if(retryBtn){
  if(retryBtn.disabled||isStreaming||!lastUserMessage)return;
  var row=retryBtn.closest('.ai-chat-retry-row');
  if(row&&row.parentNode)row.parentNode.removeChild(row);
  inputEl.disabled=false;inputEl.placeholder=IPLACE;sendBtn.disabled=false;
  inputEl.value=lastUserMessage;sendMessage();
  return;
}
var btn=e.target.closest('[data-add-to-cart]');
if(btn){e.preventDefault();var vid=btn.getAttribute('data-add-to-cart');btn.disabled=true;btn.textContent='Adding...';addToCart(vid,1).then(function(){btn.textContent='Added!';setTimeout(function(){btn.textContent='Add to Cart';btn.disabled=false},2000)}).catch(function(){btn.textContent='Error';btn.disabled=false});return}
var deadEnd=e.target.closest('[data-dead-end]');
if(deadEnd){
  var action=deadEnd.getAttribute('data-dead-end');
  if(action==='support'){
    if(SUPPORT_URL){window.open(SUPPORT_URL,'_blank','noopener');}
    else if(typeof window.zE==='function'){toggle(false);window.zE('webWidget','show');window.zE('webWidget','open');}
    else if(typeof window.Intercom==='function'){window.Intercom('show');}
    else if(typeof window.GorgiasChat!=='undefined'&&window.GorgiasChat.open){window.GorgiasChat.open();}
  }
  if(action==='new-chat'){clearChat();inputEl.disabled=false;inputEl.placeholder=IPLACE;sendBtn.disabled=false}
  return;
}
var cta=e.target.closest('[data-message]');
if(cta){var t=cta.getAttribute('data-message');if(t){inputEl.disabled=false;inputEl.placeholder=IPLACE;sendBtn.disabled=false;inputEl.value=t;sendMessage()}}
/* Chat product link clicks → set a cart attribute so the orders/create
   webhook can tag the resulting order "SEoS". keepalive lets the POST
   complete even though the browser is navigating away. Best-effort —
   any failure is silent (we don't block navigation on a tracking call). */
var prodLink=e.target.closest('a.ai-chat-product-card');
if(prodLink){
  try{
    fetch('/cart/update.js',{
      method:'POST',
      headers:{'Content-Type':'application/json','Accept':'application/json'},
      body:JSON.stringify({attributes:{_seos_attributed:'1'}}),
      keepalive:true,
      credentials:'same-origin'
    }).catch(function(){});
  }catch(_){/* ignore */}
}
});

/* Init */
if(messages.length===0)buildWelcome();
else for(var i=0;i<messages.length;i++)appendMsg(messages[i].role,messages[i].content,messages[i].products);

})();
