#!/bin/bash
#
# Hajirai app: apply generalization changes.
# Run this from the root of your hajirai project, e.g.:
#   cd ~/shopify-apps/hajirai && bash apply-changes.sh
#
set -e

if [ ! -d "app/routes" ] || [ ! -d "extensions" ]; then
  echo "ERROR: Run this from the root of your hajirai project (where app/ and extensions/ live)."
  exit 1
fi

echo "Writing files..."


mkdir -p "extensions/hajirai-chat-widget/assets"
cat > "extensions/hajirai-chat-widget/assets/hajirai-chat-widget.js" << 'EOF_WIDGET_JS'
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
var SHOP=C.shopDomain||'';
var GREET=C.greeting||'Hi! I\'m your personal shopping assistant.';
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
var QP1L=C.quickPick1Label||'';var QP1M=C.quickPick1Message||'';
var QP2L=C.quickPick2Label||'';var QP2M=C.quickPick2Message||'';
var QP3L=C.quickPick3Label||'';var QP3M=C.quickPick3Message||'';
var QP4L=C.quickPick4Label||'';var QP4M=C.quickPick4Message||'';
var SHOWBAN=C.showBanner!==false;
var DISCL=C.disclaimerText||'';
var PRIVURL=C.privacyUrl||'/pages/privacy-policy';
var LWIDTH=C.launcherWidth||'500';
var SK='hajirai_chat_session';
var HK='hajirai_chat_history';

function $(s,c){return(c||document).querySelector(s)}
function el(t,cl,h){var e=document.createElement(t);if(cl)e.className=cl;if(h)e.innerHTML=h;return e}
function esc(s){var d=document.createElement('div');d.appendChild(document.createTextNode(s));return d.innerHTML}
function fmt(c){return'$'+(c/100).toFixed(2)}
function md(t){if(!t)return'';return t.replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>').replace(/\*(.+?)\*/g,'<em>$1</em>').replace(/\[([^\]]+)\]\(([^)]+)\)/g,'<a href="$2" target="_blank" rel="noopener">$1</a>').replace(/^[-*] (.+)$/gm,'<li>$1</li>').replace(/(<li>.*<\/li>)/gs,'<ul>$1</ul>').replace(/\n{2,}/g,'</p><p>').replace(/\n/g,'<br>')}

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
var panelW=Math.max(parseInt(LWIDTH)||500,560);
panel.style.width=panelW+'px';
panel.style.maxWidth='calc(100vw - 16px)';
panel.setAttribute('role','dialog');
panel.setAttribute('aria-label','AI Shopping Assistant');

var headerAv=AVATAR?'<div class="ai-chat-header__avatar"><img src="'+AVATAR+'" alt="'+esc(NAME)+'"></div>':'<div class="ai-chat-header__avatar ai-chat-header__avatar--placeholder"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg></div>';

panel.innerHTML=
'<div class="ai-chat-header">'+headerAv+'<div class="ai-chat-header__info"><div class="ai-chat-header__name">'+esc(NAME)+'</div></div><div class="ai-chat-header__actions"><button class="ai-chat-header__btn ai-chat-menu-btn" aria-label="Menu" title="Options"><svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg></button><button class="ai-chat-header__btn ai-chat-close-btn" aria-label="Close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button></div></div>'+
'<div class="ai-chat-messages" role="log" aria-live="polite"></div>'+
'<div class="ai-chat-typing"><div class="ai-chat-msg-avatar">'+assistantBubbleAvatar+'</div><div class="ai-chat-typing-dots"><span class="ai-chat-typing-dot"></span><span class="ai-chat-typing-dot"></span><span class="ai-chat-typing-dot"></span></div></div>'+
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

/* Cache refs */
var msgsEl=$('.ai-chat-messages',panel);
var typingEl=$('.ai-chat-typing',panel);
var inputEl=$('.ai-chat-input',panel);
var sendBtn=$('.ai-chat-send',panel);
var closeBtn=$('.ai-chat-close-btn',panel);
var menuBtn=$('.ai-chat-menu-btn',panel);

var isOpen=false,isStreaming=false,messages=loadH(),abortCtrl=null;
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
  if(bb)bb.insertAdjacentHTML('beforeend','<div class="ai-chat-dead-end"><button class="ai-chat-dead-end__btn ai-chat-dead-end__btn--support" data-dead-end="support">Contact Support Team</button><button class="ai-chat-dead-end__btn ai-chat-dead-end__btn--new" data-dead-end="new-chat">Start a New Chat</button></div>');
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
h+='<div class="ai-chat-welcome__tagline">'+esc(GREET)+'</div>';
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
if(HINT)h+='<div class="ai-chat-welcome__hint">'+esc(HINT)+'</div>';
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
return '<a class="ai-chat-product-card" href="'+esc(u)+'" style="text-decoration:none;color:inherit">'+(img?'<div class="ai-chat-product-img"><img src="'+esc(img)+'" alt="'+t+'" loading="lazy"></div>':'')+'<div class="ai-chat-product-info"><span class="ai-chat-product-title">'+t+'</span><div class="ai-chat-product-price">'+pr+(cp?'<span class="compare-at">'+cp+'</span>':'')+'</div></div></a>';
}

function sendMessage(){
var text=inputEl.value.trim();
if(!text||isStreaming)return;
var w=$('.ai-chat-welcome',msgsEl);
if(w)w.remove();
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

function streamResponse(msg){
if(abortCtrl)abortCtrl.abort();
abortCtrl=new AbortController();
var body={message:msg,session_id:getSess(),shop_domain:SHOP,assistant_name:NAME,history:messages.slice(-20).map(function(m){return{role:m.role,content:m.content}})};
fetch(CHAT_URL,{method:'POST',headers:{'Content-Type':'application/json','Accept':'text/event-stream'},body:JSON.stringify(body),signal:abortCtrl.signal}).then(function(r){
if(!r.ok)throw new Error('Failed: '+r.status);
var ct=r.headers.get('content-type')||'';
if(ct.includes('text/event-stream')||ct.includes('text/plain'))return handleSSE(r);
return r.json().then(function(d){handleJSON(d)});
}).catch(function(e){
if(e.name==='AbortError')return;
typingEl.classList.remove('visible');isStreaming=false;sendBtn.disabled=false;
var em='I\'m experiencing high demand right now. Let me connect you with help!';
messages.push({role:'assistant',content:em});
var md=appendMsg('assistant',em);
var bb=$('.ai-chat-msg-bubble',md);
if(bb)bb.insertAdjacentHTML('beforeend','<div class="ai-chat-dead-end"><button class="ai-chat-dead-end__btn ai-chat-dead-end__btn--support" data-dead-end="support">Talk to Support Team</button><button class="ai-chat-dead-end__btn ai-chat-dead-end__btn--new" data-dead-end="new-chat">Start a New Chat</button></div>');
inputEl.disabled=true;inputEl.placeholder='Choose an option above';sendBtn.disabled=true;
saveH(messages);
});
}

function handleSSE(response){
var reader=response.body.getReader();
var decoder=new TextDecoder();
var buf='',full='',prods=[],msgDiv=null;
function proc(chunk){
buf+=chunk;var lines=buf.split('\n');buf=lines.pop()||'';
for(var i=0;i<lines.length;i++){
var line=lines[i].trim();
if(!line.startsWith('data: '))continue;
var data=line.slice(6);
if(data==='[DONE]'){finish(full,prods);return true}
try{
var p=JSON.parse(data);
if(p.type==='text'||p.type==='content_block_delta'){
  var tc=p.text||(p.delta&&p.delta.text)||'';
  full+=tc;typingEl.classList.remove('visible');
  if(!msgDiv)msgDiv=appendMsg('assistant',full);
  else{var b=$('.ai-chat-msg-bubble',msgDiv);if(b)b.innerHTML='<p>'+md(esc(full))+'</p>'}
  scrollBottom();
}
if(p.type==='products'&&p.products){
  prods=prods.concat(p.products);typingEl.classList.remove('visible');
  if(!msgDiv){full=full||'Here are some options for you!';msgDiv=appendMsg('assistant',full)}
  if(msgDiv){var b=$('.ai-chat-msg-bubble',msgDiv);var ep=$('.ai-chat-products',b);if(ep)ep.remove();var ph='<div class="ai-chat-products">';for(var j=0;j<prods.length;j++)ph+=prodCard(prods[j]);ph+='</div>';b.insertAdjacentHTML('beforeend',ph)}
}
if(p.type==='link'&&p.url){
  typingEl.classList.remove('visible');
  if(!msgDiv)msgDiv=appendMsg('assistant',full||'Here are some options!');
  var b=$('.ai-chat-msg-bubble',msgDiv);
  if(b)b.insertAdjacentHTML('beforeend','<a style="display:block;margin-top:10px;padding:12px 16px;background:var(--ai-chat-primary,#2d6b4f);color:#fff;border-radius:10px;text-decoration:none;text-align:center;font-size:14px;font-weight:600" href="'+esc(p.url)+'">'+esc(p.label||'Browse Collection')+' &rarr;</a>');
  scrollBottom();
}
if(p.type==='choices'&&p.options&&p.options.length){
  typingEl.classList.remove('visible');
  if(!msgDiv)msgDiv=appendMsg('assistant',full||'');
  var b=$('.ai-chat-msg-bubble',msgDiv);
  if(b){var ch='<div class="ai-chat-choices">';for(var ci=0;ci<p.options.length;ci++){ch+='<button class="ai-chat-choice-btn" data-message="'+esc(p.options[ci])+'">'+esc(p.options[ci])+'</button>'}ch+='</div>';b.insertAdjacentHTML('beforeend',ch)}
  scrollBottom();
}
if(p.type==='suggestions'&&p.questions&&p.questions.length){
  typingEl.classList.remove('visible');
  if(!msgDiv)msgDiv=appendMsg('assistant',full||'');
  var b=$('.ai-chat-msg-bubble',msgDiv);
  if(b){var sg='<div class="ai-chat-suggestions">';for(var si=0;si<p.questions.length;si++){sg+='<button class="ai-chat-suggest-btn" data-message="'+esc(p.questions[si])+'"><span class="suggest-plus">+</span> '+esc(p.questions[si])+'</button>'}sg+='</div>';b.insertAdjacentHTML('beforeend',sg)}
  scrollBottom();
}
if(p.type==='action'&&p.action==='open_zendesk'){
  setTimeout(function(){toggle(false);if(typeof window.zE==='function'){window.zE('webWidget','show');window.zE('webWidget','open')}},1500);
}
if(p.type==='action'&&p.action==='show_dead_end'){
  typingEl.classList.remove('visible');
  if(!msgDiv)msgDiv=appendMsg('assistant','It looks like I\'m having trouble finding what you need.');
  var bubble=$('.ai-chat-msg-bubble',msgDiv);
  if(bubble){
    bubble.insertAdjacentHTML('beforeend','<div class="ai-chat-dead-end"><button class="ai-chat-dead-end__btn ai-chat-dead-end__btn--support" data-dead-end="support">Talk to Support Team</button><button class="ai-chat-dead-end__btn ai-chat-dead-end__btn--new" data-dead-end="new-chat">Start a New Chat</button></div>');
  }
  /* Disable input */
  inputEl.disabled=true;inputEl.placeholder='Choose an option above';sendBtn.disabled=true;
  scrollBottom();
}
if(p.type==='error'){full=p.message||'An error occurred.';finish(full,[]);return true}
}catch(e){full+=data;typingEl.classList.remove('visible');if(!msgDiv)msgDiv=appendMsg('assistant',full);else{var bb=$('.ai-chat-msg-bubble',msgDiv);if(bb)bb.innerHTML='<p>'+md(esc(full))+'</p>'}}
}return false}
function read(){reader.read().then(function(r){if(r.done){if(full)finish(full,prods);return}var done=proc(decoder.decode(r.value,{stream:true}));if(!done)read()}).catch(function(e){if(e.name!=='AbortError')finish(full||'Connection lost.',prods)})}
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

function finish(text,prods){
typingEl.classList.remove('visible');isStreaming=false;sendBtn.disabled=false;
if(text){messages.push({role:'assistant',content:text,products:prods||[]});saveH(messages)}
var lastMsg=msgsEl.querySelector('.ai-chat-msg--assistant:last-child');
if(prods&&prods.length>0&&lastMsg){
  var b=$('.ai-chat-msg-bubble',lastMsg);
  if(b&&!$('.ai-chat-feedback',b)){
    b.insertAdjacentHTML('beforeend','<div class="ai-chat-feedback"><button class="ai-chat-fb-btn" data-vote="up"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3H14z"/><path d="M7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/></svg> Helpful</button><button class="ai-chat-fb-btn" data-vote="down"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3H10z"/><path d="M17 2h3a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-3"/></svg> Not helpful</button></div>');
    b.querySelectorAll('.ai-chat-fb-btn').forEach(function(btn){
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
}

function clearChat(){
messages=[];localStorage.removeItem(HK);localStorage.removeItem(SK);
msgsEl.innerHTML='';buildWelcome();
if(abortCtrl){abortCtrl.abort();abortCtrl=null}
isStreaming=false;sendBtn.disabled=false;typingEl.classList.remove('visible');
idleTimedOut=false;clearLastMsg();
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
var btn=e.target.closest('[data-add-to-cart]');
if(btn){e.preventDefault();var vid=btn.getAttribute('data-add-to-cart');btn.disabled=true;btn.textContent='Adding...';addToCart(vid,1).then(function(){btn.textContent='Added!';setTimeout(function(){btn.textContent='Add to Cart';btn.disabled=false},2000)}).catch(function(){btn.textContent='Error';btn.disabled=false});return}
var deadEnd=e.target.closest('[data-dead-end]');
if(deadEnd){
  var action=deadEnd.getAttribute('data-dead-end');
  if(action==='support'){toggle(false);if(typeof window.zE==='function'){window.zE('webWidget','show');window.zE('webWidget','open')}}
  if(action==='new-chat'){clearChat();inputEl.disabled=false;inputEl.placeholder=IPLACE;sendBtn.disabled=false}
  return;
}
var cta=e.target.closest('[data-message]');
if(cta){var t=cta.getAttribute('data-message');if(t){inputEl.disabled=false;inputEl.placeholder=IPLACE;sendBtn.disabled=false;inputEl.value=t;sendMessage()}}
});

/* Init */
if(messages.length===0)buildWelcome();
else for(var i=0;i<messages.length;i++)appendMsg(messages[i].role,messages[i].content,messages[i].products);

})();
EOF_WIDGET_JS

mkdir -p "extensions/hajirai-chat-widget/blocks"
cat > "extensions/hajirai-chat-widget/blocks/hajirai_chat.liquid" << 'EOF_WIDGET_LIQUID'
{% comment %}
  Hajirai AI Chat — app embed block.
  Merchants configure appearance and content here in the theme editor.
  Chat routing goes through the app proxy at /apps/hajirai/chat.
{% endcomment %}

<script>
  window.__AI_CHAT_CONFIG = {
    shopDomain: {{ shop.permanent_domain | json }},
    greeting: {{ block.settings.greeting | json }},
    greetingCta: {{ block.settings.greeting_cta | json }},
    avatarUrl: {% if block.settings.avatar != blank %}{{ block.settings.avatar | image_url: width: 200 | json }}{% else %}""{% endif %},
    bannerUrl: {% if block.settings.banner != blank %}{{ block.settings.banner | image_url: width: 800 | json }}{% else %}""{% endif %},
    assistantName: {{ block.settings.assistant_name | json }},
    assistantTagline: {{ block.settings.assistant_tagline | json }},
    launcherPlaceholder: {{ block.settings.launcher_placeholder | json }},
    inputPlaceholder: {{ block.settings.input_placeholder | json }},
    widgetPosition: {{ block.settings.position | json }},
    cta1Label: {{ block.settings.cta1_label | json }},
    cta1Message: {{ block.settings.cta1_message | json }},
    cta2Label: {{ block.settings.cta2_label | json }},
    cta2Message: {{ block.settings.cta2_message | json }},
    cta3Label: {{ block.settings.cta3_label | json }},
    cta3Message: {{ block.settings.cta3_message | json }},
    cta4Label: {{ block.settings.cta4_label | json }},
    cta4Message: {{ block.settings.cta4_message | json }},
    ctaHint: {{ block.settings.cta_hint | json }},
    quickPick1Label: {{ block.settings.qp1_label | json }},
    quickPick1Message: {{ block.settings.qp1_message | json }},
    quickPick2Label: {{ block.settings.qp2_label | json }},
    quickPick2Message: {{ block.settings.qp2_message | json }},
    quickPick3Label: {{ block.settings.qp3_label | json }},
    quickPick3Message: {{ block.settings.qp3_message | json }},
    quickPick4Label: {{ block.settings.qp4_label | json }},
    quickPick4Message: {{ block.settings.qp4_message | json }},
    showBanner: {{ block.settings.show_banner | json }},
    launcherWidth: {{ block.settings.launcher_width | json }},
    disclaimerText: {{ block.settings.disclaimer | json }},
    privacyUrl: {{ block.settings.privacy_url | json }}
  };
</script>

<style>
  :root {
    {%- if block.settings.color_primary != blank -%}
      --ai-chat-color-primary: {{ block.settings.color_primary }};
    {%- endif -%}
    {%- if block.settings.color_accent != blank -%}
      --ai-chat-color-accent: {{ block.settings.color_accent }};
    {%- endif -%}
    {%- if block.settings.color_cta_bg != blank -%}
      --ai-chat-cta-bg: {{ block.settings.color_cta_bg }};
    {%- endif -%}
    {%- if block.settings.color_cta_text != blank -%}
      --ai-chat-cta-text: {{ block.settings.color_cta_text }};
    {%- endif -%}
    {%- if block.settings.color_cta_hover != blank -%}
      --ai-chat-cta-hover: {{ block.settings.color_cta_hover }};
    {%- endif -%}
  }
  .ai-chat-overlay.visible { background: rgba(0, 0, 0, 0.4) !important; }
  .ai-chat-panel { --ai-chat-panel-w: 560px !important; }
  @media (min-width: 700px) {
    .ai-chat-welcome__ctas { grid-template-columns: repeat(4, 1fr) !important; }
  }
  body.ai-chat-blurred > *:not(.ai-chat-overlay):not(.ai-chat-panel):not(.ai-chat-launcher) {
    filter: blur(6px) !important;
    pointer-events: none !important;
    user-select: none !important;
  }
  body.ai-chat-blurred { overflow: hidden !important; }
  .ai-chat-suggestions {
    display: flex !important;
    flex-direction: column;
    gap: 8px;
    margin-top: 14px;
    padding-top: 12px;
    border-top: 1px solid #eee;
  }
  .ai-chat-suggest-btn {
    display: flex !important;
    align-items: flex-start;
    gap: 8px;
    padding: 10px 14px;
    border-radius: 10px;
    border: 1.5px solid var(--ai-chat-cta-bg, #e8f5ee);
    background: var(--ai-chat-cta-bg, #e8f5ee);
    cursor: pointer;
    color: var(--ai-chat-cta-text, #2d6b4f);
    font-size: 13px;
    font-family: inherit;
    font-weight: 500;
    line-height: 1.4;
    text-align: left;
  }
  .suggest-plus {
    color: var(--ai-chat-color-primary, #2d6b4f);
    font-weight: 700;
    font-size: 15px;
    flex-shrink: 0;
  }
</style>

<link rel="stylesheet" href="{{ 'hajirai-chat-widget.css' | asset_url }}">
<script src="{{ 'hajirai-chat-widget.js' | asset_url }}" defer></script>

{% schema %}
{
  "name": "Hajirai AI Chat",
  "target": "body",
  "settings": [
    { "type": "header", "content": "Assistant Identity" },
    {
      "type": "text",
      "id": "assistant_name",
      "label": "Assistant Name",
      "default": "AI Shopping Assistant"
    },
    {
      "type": "text",
      "id": "assistant_tagline",
      "label": "Tagline",
      "default": ""
    },
    {
      "type": "image_picker",
      "id": "avatar",
      "label": "Avatar Image"
    },
    {
      "type": "image_picker",
      "id": "banner",
      "label": "Welcome Banner"
    },
    {
      "type": "checkbox",
      "id": "show_banner",
      "label": "Show banner on welcome screen",
      "default": true
    },

    { "type": "header", "content": "Messages" },
    {
      "type": "textarea",
      "id": "greeting",
      "label": "Greeting",
      "default": "Hi! I'm your personal shopping assistant."
    },
    {
      "type": "text",
      "id": "greeting_cta",
      "label": "Greeting CTA",
      "default": "What can I help you find today?"
    },
    {
      "type": "text",
      "id": "launcher_placeholder",
      "label": "Launcher Placeholder",
      "default": "How can I help you today?"
    },
    {
      "type": "text",
      "id": "input_placeholder",
      "label": "Chat Input Placeholder",
      "default": "How can I help you today?"
    },

    { "type": "header", "content": "Layout & Colors" },
    {
      "type": "select",
      "id": "position",
      "label": "Launcher Position",
      "options": [
        { "value": "bottom-center", "label": "Bottom Center" },
        { "value": "bottom-left", "label": "Bottom Left" },
        { "value": "bottom-right", "label": "Bottom Right" }
      ],
      "default": "bottom-center"
    },
    {
      "type": "text",
      "id": "launcher_width",
      "label": "Launcher Width (px)",
      "default": "500"
    },
    {
      "type": "color",
      "id": "color_primary",
      "label": "Primary Color",
      "default": "#2d6b4f"
    },
    {
      "type": "color",
      "id": "color_accent",
      "label": "Accent Color",
      "default": "#3a7d5c"
    },
    {
      "type": "color",
      "id": "color_cta_bg",
      "label": "CTA Background",
      "default": "#e8f5ee"
    },
    {
      "type": "color",
      "id": "color_cta_text",
      "label": "CTA Text",
      "default": "#2d6b4f"
    },
    {
      "type": "color",
      "id": "color_cta_hover",
      "label": "CTA Hover",
      "default": "#d4ebdb"
    },

    { "type": "header", "content": "Welcome CTAs", "info": "Up to 4 suggested starting questions shown under the greeting." },
    { "type": "text", "id": "cta1_label", "label": "CTA 1 Label", "default": "Find a product" },
    { "type": "text", "id": "cta1_message", "label": "CTA 1 Message", "default": "Help me find a product" },
    { "type": "text", "id": "cta2_label", "label": "CTA 2 Label", "default": "Track my order" },
    { "type": "text", "id": "cta2_message", "label": "CTA 2 Message", "default": "I want to check the status of my order" },
    { "type": "text", "id": "cta3_label", "label": "CTA 3 Label", "default": "Sizing help" },
    { "type": "text", "id": "cta3_message", "label": "CTA 3 Message", "default": "I need help choosing the right size" },
    { "type": "text", "id": "cta4_label", "label": "CTA 4 Label", "default": "Browse deals" },
    { "type": "text", "id": "cta4_message", "label": "CTA 4 Message", "default": "Show me current sales and promotions" },
    { "type": "text", "id": "cta_hint", "label": "CTA Hint Text" },

    { "type": "header", "content": "Quick Picks", "info": "Shorter prompts shown as pills below the main CTAs." },
    { "type": "text", "id": "qp1_label", "label": "Quick Pick 1 Label", "default": "Best sellers" },
    { "type": "text", "id": "qp1_message", "label": "Quick Pick 1 Message", "default": "What are your best-selling products?" },
    { "type": "text", "id": "qp2_label", "label": "Quick Pick 2 Label", "default": "New arrivals" },
    { "type": "text", "id": "qp2_message", "label": "Quick Pick 2 Message", "default": "Show me what's new" },
    { "type": "text", "id": "qp3_label", "label": "Quick Pick 3 Label", "default": "On sale" },
    { "type": "text", "id": "qp3_message", "label": "Quick Pick 3 Message", "default": "What's currently on sale?" },
    { "type": "text", "id": "qp4_label", "label": "Quick Pick 4 Label", "default": "Return policy" },
    { "type": "text", "id": "qp4_message", "label": "Quick Pick 4 Message", "default": "What is your return and refund policy?" },

    { "type": "header", "content": "Footer" },
    {
      "type": "text",
      "id": "disclaimer",
      "label": "Disclaimer Text",
      "default": "Powered by AI"
    },
    {
      "type": "url",
      "id": "privacy_url",
      "label": "Privacy Policy URL"
    }
  ]
}
{% endschema %}
EOF_WIDGET_LIQUID

mkdir -p "app/routes"
cat > "app/routes/app._index.jsx" << 'EOF_APP_INDEX'
import { useLoaderData } from "react-router";
import {
  Page,
  Card,
  BlockStack,
  InlineStack,
  Text,
  InlineGrid,
  Box,
  Banner,
  Button,
  Link as PolarisLink,
  Badge,
  Divider,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { getShopConfig, getKnowledgeFiles } from "../models/ShopConfig.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const config = await getShopConfig(session.shop);
  const files = await getKnowledgeFiles(session.shop);

  return {
    hasApiKey: config.anthropicApiKey !== "",
    anthropicModel: config.anthropicModel,
    fileCount: files.length,
    shop: session.shop,
    themeEditorUrl: `https://${session.shop}/admin/themes/current/editor?context=apps`,
  };
};

function StatCard({ label, value, sublabel }) {
  return (
    <Card>
      <BlockStack gap="100">
        <Text as="p" tone="subdued" variant="bodySm">{label}</Text>
        <Text as="p" variant="heading2xl">{value}</Text>
        {sublabel && <Text as="p" tone="subdued" variant="bodySm">{sublabel}</Text>}
      </BlockStack>
    </Card>
  );
}

export default function Dashboard() {
  const { hasApiKey, anthropicModel, fileCount, shop, themeEditorUrl } = useLoaderData();

  return (
    <Page title="Analytics">
      <TitleBar title="Analytics" />
      <BlockStack gap="500">
        {!hasApiKey && (
          <Banner title="Finish setup to activate the chat assistant" tone="warning">
            <p>Add your Anthropic API key in <PolarisLink url="/app/api-keys">API Keys</PolarisLink> to activate the chat assistant.</p>
          </Banner>
        )}

        {hasApiKey && (
          <Banner title="Chat assistant is live" tone="success">
            <p>Customers on your storefront can now chat with the AI. Customize appearance and messaging in the theme editor.</p>
          </Banner>
        )}

        <InlineGrid columns={{ xs: 1, sm: 2, md: 4 }} gap="400">
          <StatCard label="Conversations" value="—" sublabel="Last 30 days" />
          <StatCard label="Messages" value="—" sublabel="Last 30 days" />
          <StatCard label="Avg. response time" value="—" sublabel="Seconds" />
          <StatCard label="Product mentions" value="—" sublabel="Click-throughs to PDP" />
        </InlineGrid>

        <Card>
          <BlockStack gap="400">
            <InlineStack align="space-between" blockAlign="center">
              <Text as="h2" variant="headingMd">Top customer questions</Text>
              <Badge tone="info">Coming soon</Badge>
            </InlineStack>
            <Text as="p" tone="subdued">
              A ranked list of what customers ask most will appear here once the chat server starts logging conversations.
            </Text>
          </BlockStack>
        </Card>

        <Divider />

        <InlineGrid columns={{ xs: 1, md: 3 }} gap="400">
          <Card>
            <BlockStack gap="200">
              <Text as="h3" variant="headingSm">AI Model</Text>
              <InlineStack gap="200" blockAlign="center">
                <Badge tone={hasApiKey ? "success" : "critical"}>
                  {hasApiKey ? "Connected" : "Not set"}
                </Badge>
              </InlineStack>
              <Text as="p" tone="subdued" variant="bodySm">{anthropicModel}</Text>
              <Button url="/app/api-keys" variant="plain">Configure</Button>
            </BlockStack>
          </Card>

          <Card>
            <BlockStack gap="200">
              <Text as="h3" variant="headingSm">Knowledge Base</Text>
              <Text as="p" variant="headingLg">{fileCount}</Text>
              <Text as="p" tone="subdued" variant="bodySm">CSV files uploaded</Text>
              <Button url="/app/knowledge" variant="plain">Manage</Button>
            </BlockStack>
          </Card>

          <Card>
            <BlockStack gap="200">
              <Text as="h3" variant="headingSm">Appearance & Content</Text>
              <Text as="p" tone="subdued" variant="bodySm">
                Branding, colors, greetings, and CTAs live in the theme editor.
              </Text>
              <Button url={themeEditorUrl} external variant="plain">
                Open theme editor
              </Button>
            </BlockStack>
          </Card>
        </InlineGrid>

        <Box paddingBlockStart="300">
          <Text as="p" tone="subdued" variant="bodySm" alignment="center">
            Installed on {shop}
          </Text>
        </Box>
      </BlockStack>
    </Page>
  );
}
EOF_APP_INDEX

mkdir -p "app/routes"
cat > "app/routes/app.api-keys.jsx" << 'EOF_APP_APIKEYS'
import { useLoaderData, useActionData, useNavigation, Form } from "react-router";
import { useState } from "react";
import { Page, Layout, Card, BlockStack, TextField, Select, Button, Banner, Box } from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { getShopConfig, updateShopConfig } from "../models/ShopConfig.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const config = await getShopConfig(session.shop);
  return {
    hasAnthropicKey: config.anthropicApiKey !== "",
    anthropicModel: config.anthropicModel,
    hasYotpoKey: config.yotpoApiKey !== "",
    hasAftershipKey: config.aftershipApiKey !== "",
  };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();

  const data = {};

  const anthropicKey = formData.get("anthropicApiKey");
  if (anthropicKey !== null && anthropicKey !== "") {
    data.anthropicApiKey = anthropicKey;
  }

  const model = formData.get("anthropicModel");
  if (model) data.anthropicModel = model;

  const yotpoKey = formData.get("yotpoApiKey");
  if (yotpoKey !== null && yotpoKey !== "") {
    data.yotpoApiKey = yotpoKey;
  }

  const aftershipKey = formData.get("aftershipApiKey");
  if (aftershipKey !== null && aftershipKey !== "") {
    data.aftershipApiKey = aftershipKey;
  }

  if (Object.keys(data).length > 0) {
    await updateShopConfig(session.shop, data);
  }

  return { success: true };
};

export default function ApiKeys() {
  const { hasAnthropicKey, anthropicModel, hasYotpoKey, hasAftershipKey } = useLoaderData();
  const actionData = useActionData();
  const nav = useNavigation();
  const saving = nav.state === "submitting";

  const [anthropicKey, setAnthropicKey] = useState("");
  const [model, setModel] = useState(anthropicModel || "claude-sonnet-4-20250514");
  const [yotpoKey, setYotpoKey] = useState("");
  const [aftershipKey, setAftershipKey] = useState("");

  return (
    <Page title="API Keys" backAction={{ url: "/app" }}>
      <TitleBar title="API Keys" />
      <Form method="post">
        <BlockStack gap="500">
          {actionData?.success && (
            <Banner title="Settings saved" tone="success" onDismiss={() => {}} />
          )}

          <Layout>
            <Layout.AnnotatedSection
              title="Anthropic API Key"
              description="Required. Powers the AI chat assistant. Get your key from console.anthropic.com"
            >
              <Card>
                <BlockStack gap="400">
                  <Banner tone={hasAnthropicKey ? "success" : "warning"}>
                    <p>{hasAnthropicKey ? "API key is configured" : "No API key set — the chat assistant won't work until you add one"}</p>
                  </Banner>
                  <TextField
                    label="Anthropic API Key"
                    type="password"
                    value={anthropicKey}
                    onChange={setAnthropicKey}
                    placeholder={hasAnthropicKey ? "••••••••••••••••" : "sk-ant-api03-..."}
                    autoComplete="off"
                    helpText="Your key is encrypted and stored securely. Leave blank to keep the existing key."
                  />
                  <Select
                    label="Claude Model"
                    options={[
                      { label: "Claude Sonnet 4 (recommended)", value: "claude-sonnet-4-20250514" },
                      { label: "Claude Haiku 4.5 (faster, cheaper)", value: "claude-haiku-4-5-20251001" },
                      { label: "Claude Opus 4 (most capable)", value: "claude-opus-4-20250514" },
                    ]}
                    value={model}
                    onChange={setModel}
                  />
                </BlockStack>
              </Card>
            </Layout.AnnotatedSection>

            <Layout.AnnotatedSection
              title="Integrations (Optional)"
              description="Connect third-party services for enhanced features like product reviews and return data."
            >
              <Card>
                <BlockStack gap="400">
                  <TextField
                    label="Yotpo API Key"
                    type="password"
                    value={yotpoKey}
                    onChange={setYotpoKey}
                    placeholder={hasYotpoKey ? "••••••••••••••••" : "Optional — for product reviews"}
                    autoComplete="off"
                    helpText="Enables the AI to reference product reviews and sizing feedback"
                  />
                  <TextField
                    label="Aftership API Key"
                    type="password"
                    value={aftershipKey}
                    onChange={setAftershipKey}
                    placeholder={hasAftershipKey ? "••••••••••••••••" : "Optional — for return/fit data"}
                    autoComplete="off"
                    helpText="Enables fit intelligence from return reason data"
                  />
                </BlockStack>
              </Card>
            </Layout.AnnotatedSection>
          </Layout>

          <input type="hidden" name="anthropicApiKey" value={anthropicKey} />
          <input type="hidden" name="anthropicModel" value={model} />
          <input type="hidden" name="yotpoApiKey" value={yotpoKey} />
          <input type="hidden" name="aftershipApiKey" value={aftershipKey} />

          <Box paddingBlockEnd="800">
            <Button variant="primary" submit loading={saving}>
              Save API Keys
            </Button>
          </Box>
        </BlockStack>
      </Form>
    </Page>
  );
}
EOF_APP_APIKEYS

mkdir -p "app/routes"
cat > "app/routes/app.knowledge.jsx" << 'EOF_APP_KNOWLEDGE'
import { useState } from "react";
import { useLoaderData, useActionData, useNavigation, useSubmit } from "react-router";
import { Page, Layout, Card, BlockStack, Text, Button, Banner, Box, DataTable, DropZone, InlineStack, Modal, Select, Thumbnail } from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { getKnowledgeFiles, saveKnowledgeFile, deleteKnowledgeFile } from "../models/ShopConfig.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const files = await getKnowledgeFiles(session.shop);
  return { files, shop: session.shop };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "upload") {
    const fileName = formData.get("fileName");
    const fileType = formData.get("fileType");
    const content = formData.get("content");
    const fileSize = parseInt(formData.get("fileSize"), 10);

    if (!content || !fileType) {
      return { error: "File and type are required" };
    }

    await saveKnowledgeFile(session.shop, { fileName, fileType, fileSize, content });
    return { success: true, message: `${fileName} uploaded successfully` };
  }

  if (intent === "delete") {
    const fileId = formData.get("fileId");
    await deleteKnowledgeFile(fileId);
    return { success: true, message: "File deleted" };
  }

  return { error: "Unknown action" };
};

export default function Knowledge() {
  const { files } = useLoaderData();
  const actionData = useActionData();
  const nav = useNavigation();
  const submit = useSubmit();
  const saving = nav.state === "submitting";

  const [selectedType, setSelectedType] = useState("faqs");
  const [uploadFile, setUploadFile] = useState(null);

  const fileTypes = [
    { label: "FAQs & Policies", value: "faqs" },
    { label: "Brand / About", value: "brand" },
    { label: "Product Details", value: "products" },
    { label: "Custom Knowledge", value: "custom" },
  ];

  function handleDropAccepted(droppedFiles) {
    const file = droppedFiles[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      setUploadFile({ name: file.name, size: file.size, content: e.target.result });
    };
    reader.readAsText(file);
  }

  function handleUpload() {
    if (!uploadFile) return;
    const formData = new FormData();
    formData.set("intent", "upload");
    formData.set("fileName", uploadFile.name);
    formData.set("fileType", selectedType);
    formData.set("fileSize", uploadFile.size.toString());
    formData.set("content", uploadFile.content);
    submit(formData, { method: "post" });
    setUploadFile(null);
  }

  function handleDelete(fileId) {
    const formData = new FormData();
    formData.set("intent", "delete");
    formData.set("fileId", fileId);
    submit(formData, { method: "post" });
  }

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  }

  const rows = files.map((f) => [
    f.fileName,
    fileTypes.find((t) => t.value === f.fileType)?.label || f.fileType,
    formatSize(f.fileSize),
    new Date(f.updatedAt).toLocaleDateString(),
    <Button tone="critical" variant="plain" onClick={() => handleDelete(f.id)}>Delete</Button>,
  ]);

  return (
    <Page title="Knowledge Base" backAction={{ url: "/app" }}>
      <TitleBar title="Knowledge Base" />
      <BlockStack gap="500">
        <Banner title="Your store is already connected" tone="info">
          <Text as="p">
            The assistant has live access to your Shopify store — products, collections, pages,
            and policies are automatically available via the Shopify API. Use this page only to
            add <strong>extra</strong> knowledge the AI should know beyond what's in your store
            (FAQs, brand voice, detailed product guides, etc.).
          </Text>
        </Banner>

        {actionData?.success && (
          <Banner title={actionData.message} tone="success" onDismiss={() => {}} />
        )}
        {actionData?.error && (
          <Banner title={actionData.error} tone="critical" onDismiss={() => {}} />
        )}

        <Layout>
          <Layout.AnnotatedSection
            title="Upload Extra Knowledge"
            description="Upload CSV or plain text files with additional context for the AI. Each category keeps one active file — uploading a new one replaces the previous."
          >
            <Card>
              <BlockStack gap="400">
                <Select
                  label="File Type"
                  options={fileTypes}
                  value={selectedType}
                  onChange={setSelectedType}
                />
                <DropZone
                  accept=".csv,.txt"
                  type="file"
                  onDropAccepted={handleDropAccepted}
                  allowMultiple={false}
                >
                  {uploadFile ? (
                    <Box padding="400">
                      <BlockStack gap="200">
                        <Text as="p" variant="bodyMd">{uploadFile.name}</Text>
                        <Text as="p" tone="subdued">{formatSize(uploadFile.size)}</Text>
                      </BlockStack>
                    </Box>
                  ) : (
                    <DropZone.FileUpload actionHint="Accepts .csv and .txt files" />
                  )}
                </DropZone>
                {uploadFile && (
                  <InlineStack gap="300">
                    <Button variant="primary" onClick={handleUpload} loading={saving}>
                      Upload {fileTypes.find((t) => t.value === selectedType)?.label}
                    </Button>
                    <Button onClick={() => setUploadFile(null)}>Cancel</Button>
                  </InlineStack>
                )}
              </BlockStack>
            </Card>
          </Layout.AnnotatedSection>

          <Layout.AnnotatedSection
            title="Uploaded Files"
            description="These files are used by the AI to answer customer questions about your products."
          >
            <Card>
              {files.length === 0 ? (
                <Box padding="400">
                  <Text as="p" tone="subdued">No files uploaded yet. Upload a CSV to get started.</Text>
                </Box>
              ) : (
                <DataTable
                  columnContentTypes={["text", "text", "text", "text", "text"]}
                  headings={["File Name", "Type", "Size", "Updated", ""]}
                  rows={rows}
                />
              )}
            </Card>
          </Layout.AnnotatedSection>
        </Layout>

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">What to upload</Text>
            <Text as="p" variant="bodySm" tone="subdued">
              <strong>FAQs & Policies</strong> — shipping, returns, warranty, common questions. Plain text (.txt) or CSV with columns: question, answer.
            </Text>
            <Text as="p" variant="bodySm" tone="subdued">
              <strong>Brand / About</strong> — your story, values, voice, and tone. Plain text (.txt).
            </Text>
            <Text as="p" variant="bodySm" tone="subdued">
              <strong>Product Details</strong> — extra product info beyond what's in Shopify (materials, care, sizing charts). CSV with columns: product_title, details.
            </Text>
            <Text as="p" variant="bodySm" tone="subdued">
              <strong>Custom Knowledge</strong> — free-form text for anything else the AI should know.
            </Text>
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
EOF_APP_KNOWLEDGE

mkdir -p "prisma"
cat > "prisma/schema.prisma" << 'EOF_PRISMA'
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "sqlite"
  url      = "file:dev.sqlite"
}

model Session {
  id            String    @id
  shop          String
  state         String
  isOnline      Boolean   @default(false)
  scope         String?
  expires       DateTime?
  accessToken   String
  userId        BigInt?
  firstName     String?
  lastName      String?
  email         String?
  accountOwner  Boolean   @default(false)
  locale        String?
  collaborator  Boolean?  @default(false)
  emailVerified Boolean?  @default(false)
  refreshToken  String?
  refreshTokenExpires DateTime?
}

model ShopConfig {
  id                  String   @id @default(cuid())
  shop                String   @unique

  assistantName       String   @default("AI Shopping Assistant")
  assistantTagline    String   @default("Smart Support for Every Step")
  greeting            String   @default("Hi! I'm your personal shopping assistant.")
  greetingCta         String   @default("What can I help you find today?")
  avatarUrl           String   @default("")
  bannerUrl           String   @default("")
  colorPrimary        String   @default("#2d6b4f")
  colorAccent         String   @default("#e8f5ee")
  colorCtaBg          String   @default("#e8f5ee")
  colorCtaText        String   @default("#2d6b4f")
  colorCtaHover       String   @default("#d6eee0")

  launcherPlaceholder String   @default("How can I help you today?")
  inputPlaceholder    String   @default("How can I help you today?")
  launcherWidth       String   @default("500")
  widgetPosition      String   @default("bottom-center")
  showBanner          Boolean  @default(true)

  cta1Label           String   @default("")
  cta1Message         String   @default("")
  cta2Label           String   @default("")
  cta2Message         String   @default("")
  cta3Label           String   @default("")
  cta3Message         String   @default("")
  cta4Label           String   @default("")
  cta4Message         String   @default("")

  qp1Label            String   @default("")
  qp1Message          String   @default("")
  qp2Label            String   @default("")
  qp2Message          String   @default("")
  qp3Label            String   @default("")
  qp3Message          String   @default("")
  qp4Label            String   @default("")
  qp4Message          String   @default("")

  ctaHint             String   @default("")
  disclaimerText      String   @default("Powered by AI")
  privacyUrl          String   @default("/pages/privacy-policy")

  anthropicApiKey     String   @default("")
  anthropicModel      String   @default("claude-sonnet-4-20250514")
  yotpoApiKey         String   @default("")
  aftershipApiKey     String   @default("")

  createdAt           DateTime @default(now())
  updatedAt           DateTime @updatedAt
}

model KnowledgeFile {
  id        String   @id @default(cuid())
  shop      String
  fileName  String
  fileType  String
  fileSize  Int
  content   String
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([shop])
}
EOF_PRISMA

# Delete the old config proxy route (no longer used)
rm -f app/routes/config.jsx

echo ""
echo "Files written."
echo ""
echo "Next steps:"
echo "  1. npx prisma migrate dev --name remove_chat_server_url"
echo "  2. Restart shopify app dev"
echo "  3. Test the widget"
echo "  4. git add -A && git commit -m 'Generalize app for public app store' && git push"
