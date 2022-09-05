(function(self){
	
	importScripts('/lib.js');

	const ts=(new Date()).getTime();
	function getDurration(){
		let durr=(new Date()).getTime()-ts;
		return "	t = "+durr;
	}

	self.isRunning=false;
	async function onRunning(){
		try{
			if(!self.isRunning){
				self.isRunning=true;
				await setupDatabase();
				await setupHeartbeat();
				await setupBackgroundSync();
				return true;
			}
		}catch(e){
			self.logErrors(e);
		}
		return false;
	}

	if(self.loaded){
		console.warn("serviceworker.js script already loaded at "+self.started,self)
	}else{
		self.started=(new Date()).toUTCString();
		console.warn("loading serviceworker.js script at "+self.started,self);
		
	}




	//1. The first event to fire is 'install'. This is where you might create a cache and populate it. It will 
	//   only be called the first time the page is loaded
	self.addEventListener('install',event=>event.waitUntil(onInstall(event)));

	//2. The second event is 'activate'. This is where you might clean up data associated with the previous
	//   version of your service worker. This too will only be called on the first page load, after that the 
	//   service worker will already be active and running in the background
	self.addEventListener('activate',event=>event.waitUntil(onActivate(event)));

	//3. This is called on every subsequent fetch...
	self.addEventListener('fetch',event=>event.respondWith(onFetch(event)));

	

	//When a notification generated by this worker is clicked, show the page
	self.addEventListener('notificationclick',showWindow);

	self.registration.addEventListener('updatefound', (evt) => {
        console.warn('Service Worker update found!',evt);
        //TODO: add broadcast to client
    });



    self.notify=notify;
	async function notify(){
		try{
			let note=self.prepareNotificationObj.apply(this,arguments);
			if(self.pageChannel){
				logHistory('notify',{where:'service deligating to frontend',note});
				await self.pageChannel.postMessage({subject:'notification',payload:note});
			}else{
				logHistory('notify',{where:'service posting from background',note});
				await self.registration.showNotification(note.title,note);
			}
		}catch(e){
			logHistory('notify_error',e.message);
			console.error(e,arguments);
		}
		self.setLast('notification',Date.now());
	}
	 
	self.broadcast=broadcast
	function broadcast(subject,payload){
		let msg={subject,payload}
		console.warn("BROADCAST:",msg);
		self.pageChannel.postMessage(msg);
	}




  	//Make enpoints available to main page
	const public={
		clearCache:()=>caches.delete(self.paragast.cacheName)
		,checkNewHeadlines:(limit)=>self.checkNewHeadlines(limit)
		,getAllHeadlines:()=>self.db.getAll('headlines').then(arr=>arr.sort(self.sortHeadlines))
		,destroyDatabase:()=>self.db.destroy()
		,removeBackgroundSync
	}
	self.addEventListener('message',event=>{
		if(event.data=='REGISTER'){
			//First message sent by Service.connect() in app.js
			self.pageChannel=event.ports[0];
			self.pageChannel.postMessage('REGISTERED');
		}else{
			// console.log(event);
			pageMessageHandler(event.data);
		}
	});
	async function pageMessageHandler({method,payload,msgId}){
		try{
			if(typeof public[method]=='function'){
				let ep="SERVICE."+method+"()";
				console.warn("APP => "+ep);
				try{
					var response=await public[method](payload);
				}catch(e){
					var err=e;
				}
				let data={msgId,response,err};
				console.log(ep+" => APP: ",data)
				try{
					self.pageChannel.postMessage(data);
				}catch(cause){
					self.logErrors(new Error("Failed to send response to app",{cause}),data);
				}
			}else{
				console.error("No such public endpoint:",method,payload,msgId);
			}
		}catch(cause){
			self.logErrors("BUGBUG pageMessageHandler():",cause);
		}
	}



	self.setupHeartbeat('service in script');


    






    





	/**
	 * https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerGlobalScope/install_event
	 * 
	 * @return void
	 * @async
	 */
	async function onInstall(event){
		try{
			console.warn('EVENT: install'+getDurration());

			var paralell=[];


			//If opted preload resources and populate the cache
			if(self.paragast.primeCacheList){
				paralell.push(
					preloadResources(self.paragast.primeCacheList)
						.catch(err=>{self.logErrors("Failed to prime cache with:",list,err);})
				);
			}else{
				console.info("Not priming cache.")
			}

			//If opted setup a database
			if(self.paragast.database){
				paralell.push(setupDatabase())
			}else{
				console.info("No IndexedDB defined in config, not setting one up.")
			}

					

			await Promise.all(paralell);
			
			console.warn('FINISHED: install'+getDurration());
			logHistory('installed');
			self.setupHeartbeat('service after install');
			//Let this happen in the background
			setTimeout(checkSelfUpdate,3000);
		}catch(cause){
			self.logErrors(new Error("'install' failed @ "+getDurration(),{cause}),self);
		}
		return;
	};

	/**
	 * https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerGlobalScope/activate_event
	 * 
	 * @return void
	 * @async
	 */
	async function onActivate(event){
		try{
			console.warn('EVENT: activate'+getDurration());
			
			checkSelfUpdate();

			if(!self.paragast.waitForServiceWorkerBoot){
				// If supported, enable navigation preloads. This means that while the service worker is booting up any
				// requests made of it are dispatched directly to the server which in turn implies that we may start a 
				// fetch for a resource which is actually cached, ie. we make the request "just in case"
				if (self.registration.navigationPreload) {
					console.log("allowing server fetching while service worker boots")
					await self.registration.navigationPreload.enable();
				}else{
					console.warn("preloading content is not supported, will wait for service worker boot to finish");
				}
			}else{
				console.warn("waiting for service worker to boot before performing fetching resources")
			}


			if(self.paragast.periodicSync){
				await setupBackgroundSync();
			}else{
				console.info("No periodic background sync defined in config, not setting any up.")
			}

			logHistory('activated')
		}catch(e){
			self.logErrors(e);
		}
		// console.log('FINISHED: activate'+getDurration());
		return;
	}


	/**
	 * Intercepts fetch events and returns either a cached or newly fetched response, possibly a 404
	 * 
	 * @param <FetchEvent> event  An extened event with additional properties: .clientId, .preloadResponse, 
	 *                            .replacesCliendId, .resultingClientId, .request and method .respondWith()
	 *                                 https://developer.mozilla.org/en-US/docs/Web/API/FetchEvent
	 * 
	 * @return Promise(<Response>)    Always resolves with a response object
	 * @async
	 */
	async function onFetch(event){
		try{
			var response,src;

			console.debug('FETCHING '+event.request.url+getDurration());
			checkSelfUpdate();
			onRunning(); //runs async, never throws
			
			//First we check the cache
			src="cache";
			response=await caches.match(event.request); 
			if(!response){ 
				//Then we ask the server...
				try{
					//If self.paragast.waitForServiceWorkerBoot==false then we enabled navigationPreloading on the 'activate' event
					//which means that the fetch may already have been performed, otherwise we do so now...
					src="server-preload";
					response=await event.preloadResponse; //this resolves with undefined...
					if(!response){
						src="server"
						console.debug("Fetching from server now: "+event.request.url+getDurration());
						response=await fetch(event.request);
					}

					// Cache a copy of successfull responses. This happens async and we don't have to wait for it...
					cacheResponse(event.request,response.clone());
					
				}catch(e){
					//The only error which should be thrown here is if the request couldn't be made at 
					//all, eg. a network error. Since we need a response we create one
					response=new Response('Could not perform fetch. Possible network error. See console.', {
						status: 408
						,statusText:"Client error"
						,headers: { 'Content-Type': 'text/plain' }
						,url: event.request.url
					});
					throw e;
				}
				logHistory('fetch_server',event.request.url);
			}else{
				logHistory('fetch_cache',event.request.url);
			}

			//If we don't have a response now something has gone wrong!
			if(!response){
				throw new Error("BUGBUG: something wrong in code, we should have a response object by now");
			}

		}catch(e){
			self.logErrors(e,getDurration(),{event,response,src});

			response=response|| new Response("Failed to fetch resource, unknown client-side error. See console", {
				status: 500
				,statusText: "Client error"
				,headers: { 'Content-Type': 'text/plain' }
				,url: event.request.url
			});
		}

		console.debug(`FINISHED: **${src}** fetch ${event.request.url}`+getDurration(),response);
		return response;
	};








	/**
	 * Store a response to the cache IF it's successful
	 * 
	 * @param object request             The event.request object from fetch-event
	 * @param <Response> clonedResponse  An already cloned response
	 * 
	 * @return void
	 * @async 
	 */
	async function cacheResponse(request,clonedResponse){
		try{
			if(clonedResponse && clonedResponse.status>=200 && clonedResponse.status<300){
				// responses may only be used once, so we store a clone to the cache
				let cache = await caches.open(self.paragast.cacheName);
				await cache.put(request, clonedResponse);
				// console.log("Cached "+request.url+getDurration())
			}else{
				console.warn("Not caching response with status "+clonedResponse.status,clonedResponse);
			}

		}catch(e){
			self.logErrors("Failed to cache response",{request,response:clonedResponse},e);
		}
		return;
		
	}


	async function preloadResources(list){
		try{
			console.log("priming cache with the following list of resources:",list)
			var cache=await caches.open(self.paragast.cacheName);
			await cache.addAll(list);
		}catch(e){
			return Promise.reject(e)
		}
	}




	async function checkSelfUpdate(){
		try{
			var now=Date.now();
			if(!self.lastUpdateCheck || self.lastUpdateCheck < (now-self.paragast.updateCheckInterval)){
				console.log("Checking for update of service worker now...");
				await self.registration.update();
				self.lastUpdateCheck=now;
				return true;
			}
		}catch(e){
			self.lastUpdateCheck=(now-60*1000); 
				//^set the last check to be 1 minute ago, so we at least don't check right away again sssssss

			self.logErrors(e);
		}
		return false;
	}




	async function subscribeToMessages(){
		try {
			console.log("SUBSCRIBE"+getDurration());
			let options = {}
			let subscription = await self.registration.pushManager.subscribe(options)
			console.log("Subscribed:"+getDurration(),subscription);
		} catch (e) {
			self.logErrors(e);
		}

	}


	
	function showWindow(event){
	  	console.log('Background notification clicked!',event);
	  	setTimeout(()=>event.notification.close(),2000);

	  	// This looks to see if the current is already open and focuses if it is
		event.waitUntil(
		  	clients.matchAll({
			    type: "window"
			})
		  	.then((clientList) => {
		  		console.warn(clientList,clients);
			    for (const client of clientList) {
			    	if (client.url === '/' && 'focus' in client)
			        	return client.focus();
			    }
			    if (clients.openWindow)
			    	return clients.openWindow('/');
			})
		);
	}



	function setupDatabase(){
		if(!self.db){
			self.db=new self.Database(self.paragast.database);
			return self.db.setup()
				.catch(err=>{self.logErrors("Failed to setup database:",err);})
				.then(async function primeHeadlinesStore(){
					if(!await self.getLast('headlines')){
						let newest=self.formatDate('string',Date.now()-(1000*60*60*3));
						console.log(`Downloading headlines older than ${newest} to prime database`);
						let oldHeadlines=await self.fetchHeadlines("&to="+newest+"&page=2");
						await self.storeHeadlines(oldHeadlines);
					}
					return true;
				})
			;
		}else{
			return Promise.resolve(false);
		}
	}


	/**
	 * Setup a periodic running of something in the background
	 * 
	 * NOTE: this requires an active service worker, so do in activate event
	 * */
	async function setupBackgroundSync(){
		try{
			const conf=self.paragast.periodicSync;
			const tags = await self.registration.periodicSync.getTags();
			if(tags.includes(conf.name)){
				console.warn(`Background sync for '${conf.name}' already registered`);
			}else{
				await self.registration.periodicSync.register(conf.name, {
					minInterval: conf.interval
				});
				console.warn('setup periodic background sync');
				logHistory("periodic_setup",conf);
				//this will merely fire an event, we have to listen for the event
			}
		}catch(e){
			logErrors("Failed to register periodic background sync",e);
		}
	}
	function onPeriodicSync(event){
		logHistory("periodic_run",event.tag);
		if(event.tag === self.paragast.periodicSync.name){
			event.waitUntil(self.checkNewHeadlines(1));
		}else{
			console.warn("UNKNOWN PERIODIC SYNC EVENT:",event);
		}
	}
	self.addEventListener('periodicsync',onPeriodicSync);

	function removeBackgroundSync(){
		self.registration.periodicSync.getTags().then(tags=>{
			if(tags.includes(conf.name)){
				console.warn("Removing periodic background sync");
				return self.registration.periodicSync.unregister(self.paragast.periodicSync.name);
			}else{
				console.log("No periodic sync registered, nothing to remove")
			}
		})
	}


})(self)

	




