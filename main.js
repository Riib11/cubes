// Copyright 2011-2012 Kevin Reid under the terms of the MIT License as detailed
// in the accompanying file README.md or <http://opensource.org/licenses/MIT>.
//
// Exception: The overall structure of WebGL initialization and context
// management is derived from Learning WebGL, Lesson 16, at
// http://learningwebgl.com/blog/?p=1786 (as of September 2011). No license is
// stated on that site, but I (Kevin Reid) believe that it is obviously the
// authors' intent to make this code free to use.

// Main loop scheduling, scene drawing, performance statistics, etc.

(function () {
  "use strict";
  
  var Audio = cubes.Audio;
  var Blockset = cubes.Blockset;
  var BlockType = cubes.BlockType;
  var Cell = cubes.storage.Cell;
  var Config = cubes.Config;
  var dynamicText = cubes.util.dynamicText;
  var Input = cubes.Input;
  var measuring = cubes.measuring;
  var missingPlatformFeatures = cubes.util.missingPlatformFeatures;
  var mkelement = cubes.util.mkelement;
  var ObjectUI = cubes.ObjectUI;
  var PersistencePool = cubes.storage.PersistencePool;
  var Player = cubes.Player;
  var ProgressBar = cubes.util.ProgressBar;
  var Renderer = cubes.Renderer;
  var World = cubes.World;
  
  function noop() {}
  
  function padRight(string, length) {
    string = String(string);
    return new Array(length - string.length + 1).join(" ") + string;
  }
  
  // rootURL should be the directory containing this script (unfortunately not directly available).
  function Main(rootURL, timestep, storage) {
    var main = this;
    
    var config = new Config(storage, "cubes.option.");
    
    var persistencePool = new PersistencePool(storage, "cubes.object."); // note: storage may be undefined, pool  will be a stub
    
    // time parameters
    var timestep_ms = timestep*1000;
    var maxCatchup_ms = timestep_ms*3; // arbitrary/tuned, not magic
    
    // GL objects
    var gl;
    var theCanvas;
    var renderer;
    
    var audio = new Audio(config);
    
    // HTML elements and other UI pieces
    var sceneInfo;
    var worldOverlayContainer;
    var chunkProgressBar;
    var persistenceProgressBar;
    var measureDisplay;
    var currentWorldChipContainer;
    
    var focusCell = new Cell("focus", false);
    focusCell.whenChanged(function () {
      scheduleDraw();
      return true;
    });
    
    var objectUI = new ObjectUI(persistencePool);
    
    // Game state, etc. objects
    var player;
    var topWorldC = new Cell("topWorld", null);
    var input;
    
    var readyToDraw = false;
    
    function getOrDefaultOrMake(selection, defaultName, maker) {
      if (persistencePool.has(selection) && !config.alwaysGenerateWorld.get()) {
        try {
          return persistencePool.get(selection);
        } catch (exception) {
          // TODO: Propagate this to the UI; the user should know of data loss
          if (typeof console !== "undefined") console.log("Failed to load selected:", exception);
        }
      }
      
      if (persistencePool.has(defaultName) && !config.alwaysGenerateWorld.get()) {
        try {
          return persistencePool.get(defaultName);
        } catch (exception) {
          // TODO: Propagate this to the UI; the user should know of data loss
          if (typeof console !== "undefined") console.log("Failed to load default:", exception);
        }
      }
      
      var obj = maker();
      if (persistencePool.available && !config.alwaysGenerateWorld.get() && !persistencePool.has(defaultName)) {
        persistencePool.persist(obj, defaultName);
      }
      return obj;
    }
    
    // Position an overlay HTML element adjacent to the provided set of points.
    function positionByWorld(element, keepInBounds, pointGenerator) {
      var canvasStyle = window.getComputedStyle(theCanvas,null);
      var canvasWidth = parseInt(canvasStyle.width, 10);
      var canvasHeight = parseInt(canvasStyle.height, 10);
      
      var elemStyle = window.getComputedStyle(element, null);
      var elemWidth = parseInt(elemStyle.width, 10);
      var elemHeight = parseInt(elemStyle.height, 10);
      
      var slx = Infinity;
      var sly = Infinity;
      var shx = -Infinity;
      var shy = -Infinity;
      var toScreenPoint = vec4.create();
      
      pointGenerator(function (x, y, z, w) {
        toScreenPoint[0] = x;
        toScreenPoint[1] = y;
        toScreenPoint[2] = z;
        toScreenPoint[3] = w;
        renderer.transformPoint(toScreenPoint);
        toScreenPoint[0] /= toScreenPoint[3];
        toScreenPoint[1] /= toScreenPoint[3];
        toScreenPoint[2] /= toScreenPoint[3];
        if (toScreenPoint[3] > 0) {
          slx = Math.min(slx, toScreenPoint[0]);
          shx = Math.max(shx, toScreenPoint[0]);
          sly = Math.min(sly, toScreenPoint[1]);
          shy = Math.max(shy, toScreenPoint[1]);
        }
      });
      
      if (shx > -1 && shy > -1 && slx < 1 && sly < 1 /* visible */) {
        // convert to screen
        slx = (slx + 1) / 2 * canvasWidth;
        //shx = (shx + 1) / 2 * canvasWidth;
        //sly = (sly + 1) / 2 * canvasHeight;
        shy = (shy + 1) / 2 * canvasHeight;
        if (keepInBounds) {
          slx = Math.max(0, Math.min(canvasWidth - elemWidth, slx));
          shy = Math.max(0, Math.min(canvasHeight - elemHeight, shy));
        }
        element.style.left   = slx + "px";
        element.style.bottom = shy + "px";
      } else {
        element.style.left   = canvasWidth + "px";
      }
    }
    
    var lastGLErrors = [];
    function drawScene(playerRender) {
        var wrend = playerRender.getWorldRenderer();
        
        renderer.setExposure(player.getExposure());
        
        renderer.setViewToSkybox(playerRender, focusCell.get());
        renderer.skybox.draw();
        gl.clear(gl.DEPTH_BUFFER_BIT);
        
        renderer.setViewToEye(playerRender, focusCell.get());
        
        var seenElems = [];
        function drawSceneObject(sceneObject) {
          sceneObject.draw(); // TODO should probly be closed over instead
          var element = sceneObject.element;
          if (element) {
            if (!element.parentNode) worldOverlayContainer.appendChild(element);
            positionByWorld(element, true, sceneObject.boundsPoints);
            seenElems.push(element);
          }
        }

        playerRender.forEachSceneObject(drawSceneObject);
        
        // Remove old overlays
        for (var element = worldOverlayContainer.firstChild; element; element = enext) {
          var enext = element.nextSibling;
          if (seenElems.indexOf(element) === -1) {
            worldOverlayContainer.removeChild(element);
          }
        }
        
        var e, errs = [];
        while ((e = gl.getError()) !== gl.NO_ERROR && e !== gl.CONTEXT_LOST_WEBGL) {
          errs.push(e);
        }
        // Note: The above comparison is an != rather than !== because webgl-debug.js's wrapped context returns numeric strings (!) instead of numbers for error enums. TODO: File bug.
        
        // Per-frame debug/stats info
        var frameDesc = "";
        
        var pp = player.render.getPosition();
        var d = 2;
        frameDesc += "XYZ: " + pp[0].toFixed(d) + "," + pp[1].toFixed(d) + "," + pp[2].toFixed(d) + "\n";
        
        if (errs.length) {
          lastGLErrors = errs;
          frameDesc += "GL errors:";
          errs.forEach(function (e) {
            frameDesc += " " + WebGLDebugUtils.glEnumToString(e);
          });
          frameDesc += "\n";
        } else if (lastGLErrors.length) {
          frameDesc += "Previous GL errors:";
          lastGLErrors.forEach(function (e) {
            frameDesc += " " + WebGLDebugUtils.glEnumToString(e);
          });
          frameDesc += "\n";
        }
        sceneInfo.data = frameDesc;
        
        chunkProgressBar.setByTodoCount(wrend.chunkRendersToDo());
        persistenceProgressBar.setByTodoCount(persistencePool.status.get());
        
        measuring.chunkQueueSize.inc(wrend.chunkRendersToDo());
        measuring.persistenceQueueSize.inc(persistencePool.status.get());
        measuring.queues.end();
        measuring.queues.start();
        
        measuring.frameCount.inc();
        measuring.bundles.inc(renderer.bundlesDrawn);
        measuring.vertices.inc(renderer.verticesDrawn);
        renderer.bundlesDrawn = 0;
        renderer.verticesDrawn = 0;
    }
    
    var lastStepTime = null;
    function doOneStep() {
      measuring.sim.start();
      player.stepYourselfAndWorld(timestep);
      input.step(timestep);
      measuring.sim.end();
      measuring.simCount.inc();
    }
    function doSimulationSteps() {
      // perform limited catch-up
      var now = Date.now();
      if (lastStepTime === null)
        lastStepTime = now;
      if ((now - lastStepTime) > maxCatchup_ms)
        lastStepTime = now - maxCatchup_ms;
      
      while ((now - lastStepTime) > timestep_ms) {
        doOneStep();
        lastStepTime += timestep_ms;
      }
    }
    
    var drawingWasRequested = false;
    
    function animationFrameHandler() {
      doSimulationSteps();
      
      // It would be nice if we could just notice whenever a relayout occurs, but there's no hook for this, so checking every step will have to do. This handles the case where the window is not resized but an internal-to-the-page effect reshapes the viewport (e.g. panels).
      renderer.checkForViewportChange();
      
      if (drawingWasRequested && readyToDraw && !renderer.contextLost) {
        drawingWasRequested = false;
        
        // done here because chunk updating should be deprioritized at the same time drawing would be
        player.render.getWorldRenderer().updateSomeChunks();

        measuring.frame.start();
        drawScene(player.render);
        measuring.frame.end();
        
        if (config.debugForceRender.get()) scheduleDraw();
      }
      
      measureDisplay.updateIfVisible();
      
      startAnimationLoop();
    }
    config.debugForceRender.listen({
      interest: function () { return true; },
      changed: scheduleDraw
    });

    function scheduleDraw() {
      drawingWasRequested = true;
    }
    
    function startAnimationLoop() {
      window.requestAnimationFrame(animationFrameHandler, theCanvas);
    }
    
    // statistics are reset once per second
    measuring.second.start();
    setInterval(function () {
      measuring.second.end();
      measuring.second.start();
      if (measureDisplay) measureDisplay.updateIfVisible();
    }, 1000);
    
    var t0;
    function startupMessage(text) {
      var t1 = Date.now();
      sceneInfo.data += text + "\n";
      if (typeof console !== "undefined") {
        console.log(t0 ? "(+" + padRight(t1-t0, 5) + " ms)"
                       : "           ",
                    text);
      }
      t0 = t1;
    }
    
    // for making our loading more async
    var ABORT = {};
    function sequence(actions, catcher) {
      function sub(i) {
        if (i >= actions.length) {
          return;
        } else {
          setTimeout(function () {
            var a = actions[i];
            if (typeof a === "string") {
              startupMessage(a);
            } else {
              try {
                if (a(function () { sub(i+1); }) === ABORT) { return; }
              } catch (e) {
                catcher(e);
              }
            }
            sub(i+1);
          }, 1);
        }
      }
      sub(0);
    }
    
    this.start = function (pageElements, callback) {
      var tStart = Date.now();
      
      var sceneInfoOverlay = pageElements.sceneInfoOverlay;
      
      currentWorldChipContainer = document.createElement("div");
      sceneInfoOverlay.appendChild(currentWorldChipContainer);
      
      // Overall info overlay
      var sceneInfoTextElem = document.createElement("pre");
      sceneInfoOverlay.appendChild(sceneInfoTextElem);
      sceneInfo = dynamicText(sceneInfoTextElem);
      
      // Performance info
      measureDisplay = measuring.all.createDisplay(document, "cubes.measurement-ui");
      // Inserted later once startup is finished.
      
      // Progress bars
      chunkProgressBar = new ProgressBar();
      persistenceProgressBar = new ProgressBar();
      sceneInfoOverlay.appendChild(chunkProgressBar.element);
      sceneInfoOverlay.appendChild(persistenceProgressBar.element);
      
      worldOverlayContainer = pageElements.worldOverlays;
      
      objectUI.setPanelContainer(pageElements.panelContainer);
      
      var shaders;
            
      // Save button
      if (pageElements.saveButton) (function () {
        var saveButton = pageElements.saveButton;
        var originalUIText = saveButton.textContent;
        var saveButtonText = dynamicText(saveButton);
        var lastSavedTime = Date.now();
        persistencePool.status.nowAndWhenChanged(function (count) {
          if (count === 0) {
            lastSavedTime = Date.now();
            saveButton.style.visibility = "hidden";
          } else {
            saveButton.style.visibility = "visible";
            saveButtonText.data = originalUIText + " (last " + Math.round((Date.now() - lastSavedTime) / (1000*60)) + " min ago)";
          }
          return true;
        });
      }());
      
      // Object list
      if (pageElements.objectList) (function () {
        var objectList = pageElements.objectList;
        function updateObjectList() {
          var totalSize = 0;
          objectList.textContent = "";
          persistencePool.forEach(function (name, type) {
            var typeText;
            switch (type) {
              case World: typeText = "world"; break;
              case Blockset: typeText = "blockset"; break;
              case BlockType: typeText = "block type"; break;
              default: typeText = "???"; break;
            }
            
            var chip = new objectUI.ObjectChip(objectUI.refName(name));
            
            var size = persistencePool.getSize(name);
            totalSize += size;
            
            var row;
            objectList.appendChild(row = mkelement("tr", "",
              mkelement("td", "", typeText),
              mkelement("td", "", chip.element),
              mkelement("td", "", (size/1000).toFixed(0) + "K")
            ));
            
            if (persistencePool.getIfLive(name) === topWorldC.get()) row.classList.add("selected");
            
            row.addEventListener("click", function () {
              var obj = persistencePool.get(name);
              if (obj instanceof World) {
                main.setTopWorld(obj);
              }
            });
          });
          
          objectList.appendChild(mkelement("tr", "",
            mkelement("th"),
            mkelement("th", "", "Total"),
            mkelement("td", "", (totalSize/1000).toFixed(0) + "K")
          ));
        }
        updateObjectList();
        topWorldC.whenChanged(function () {
          updateObjectList();
          return true;
        }); // TODO unnecessarily rebuilding the list
        persistencePool.listen({
          interest: function () { return true; },
          added: updateObjectList,
          deleted: updateObjectList
        });
      }());

      // Object list for blockset
      // TODO: redundant with the object list; abstract this
      if (pageElements.generateBlocksetList) (function () {
        var blocksetList = pageElements.generateBlocksetList;
        function updateBlocksetList() {
          blocksetList.textContent = "";
          persistencePool.forEach(function (name, type) {
            if (type !== Blockset) return;
            var row = mkelement("option", "", name);
            row.value = name;
            blocksetList.appendChild(row);
          });
          blocksetList.value = config.generate_blockset.get();
        }
        updateBlocksetList();
        persistencePool.listen({
          interest: function () { return true; },
          added: updateBlocksetList,
          deleted: updateBlocksetList
        });
      }());
      
      var shallLoadWorld = !config.alwaysGenerateWorld.get() && persistencePool.has(config.currentTopWorld.get());

      // Main startup sequence
      sequence([
        function () {
          var failures = missingPlatformFeatures();
          if (failures !== "") {
            var notice = pageElements.featureError[0];
            var text   = pageElements.featureError[1];
            notice.style.removeProperty("display");
            text.appendChild(document.createTextNode(failures));
          }
        },
        "Downloading resources...",
        function (cont) {
          Renderer.fetchShaders(rootURL, function (s) {
            if (s === null) {
              // TODO abstract error handling; this duplicates the sequence catcher
              var notice = pageElements.loadError[0];
              var text   = pageElements.loadError[1];
              notice.style.removeProperty("display");
              text.appendChild(document.createTextNode("Failed to download shader files."));
              if (/^file:/.test(window.location.href)) {
                text.appendChild(document.createTextNode("\n\nThis is probably because your browser is (rightfully) prohibiting access to local files. Please try accessing Cubes via a web server (http://...) instead."));
              }
              return;
            }
            shaders = s;
            cont();
          });
          return ABORT; // actually continue by calling cont()
        },
        "Setting up WebGL...",
        function () {
          theCanvas = pageElements.viewCanvas;
          try {
            renderer = main.renderer = new Renderer(config, theCanvas, shaders, scheduleDraw);
            objectUI.setRenderer(renderer);
          } catch (e) {
            if (e instanceof Renderer.NoWebGLError) {
              pageElements.webglError[0].style.removeProperty("display");
              return ABORT;
            } else {
              throw e;
            }
          }
          gl = renderer.context;
        },
        shallLoadWorld ? "Loading saved worlds..." : "Creating worlds...",
        function () {
          // Save-on-exit
          window.addEventListener("unload", function () {
            persistencePool.flushNow();
            return true;
          }, false);
          
          if (!topWorldC.get()) { // If world was defined prior to start(), don't set up one
            var world = getOrDefaultOrMake(config.currentTopWorld.get(), "Default World", function () {
              var blockset = getOrDefaultOrMake(config.generate_blockset.get(), "Default Blockset", function () {
                startupMessage("  Creating default blockset...");
                return cubes.WorldGen.newDefaultBlockset(Math.round(config.generate_tileSize.get()));
              });
              startupMessage("  Creating overworld...");
              return cubes.generateWorlds(config, blockset);
            });
            
            main.setTopWorld(world);
          }
        },
        //"Creating your avatar...", // not currently expensive enough for a msg
        function () {
          player = main.player = new Player(config, topWorldC.get(), renderer/*TODO facet? */, audio/*TODO facet? */, scheduleDraw, objectUI);
          
          // TODO this is not really the right interface, just what was available
          function changedWorld () {
            if (currentWorldChipContainer) {
              var chip = new objectUI.ObjectChip(objectUI.refObject(player.getWorld()));
              currentWorldChipContainer.textContent = ""; // clear
              currentWorldChipContainer.appendChild(chip.element);
            }
          }
          player.input.listen({
            interest: function () { return true; },
            changedWorld: changedWorld,
            changedTool: noop
          });
          changedWorld();
        },
        "Painting blocks...",
        function () {
          // force lazy init to happen now rather than on first frame
          player.getWorld().blockset.getRenderData(renderer/*TODO facet?*/);
        },
        "Finishing...",
        function () {
          input = main.input = new Input(config, theCanvas, player.input, pageElements.hud, renderer, focusCell, main.save.bind(main), objectUI);
          
          objectUI.setNormalFocusElement(theCanvas);
          theCanvas.focus();
          
          readyToDraw = true;
          sceneInfoOverlay.insertBefore(measureDisplay.element, sceneInfoTextElem.nextSibling);
          startAnimationLoop();
          
          startupMessage("Ready!");
          console.log("Total", Date.now() - tStart, "ms since start()");
          callback(null);
        }
      ], function (exception) {
        startupMessage(exception);
        var notice = pageElements.loadError[0];
        var text   = pageElements.loadError[1];
        notice.style.removeProperty("display");
        text.appendChild(document.createTextNode(String(exception)));
        callback(exception);
        throw exception; // propagate to browser console
      });
    };
    
    this.regenerate = function () {
      var world = cubes.generateWorlds(config, persistencePool.get(config.generate_blockset.get()));
      persistencePool.persist(world, config.generate_name.get());
      this.setTopWorld(world);
    };
    var genOKCell = new Cell("main.regenerateOK", false);
    this.regenerateOK = genOKCell.readOnly;
    function recalcGenOK() {
      genOKCell.set(!persistencePool.has(config.generate_name.get()));
    }
    config.generate_name.whenChanged(recalcGenOK);
    persistencePool.listen({
      interest: function () { return true; },
      added: recalcGenOK,
      deleted: recalcGenOK
    });
    
    this.setTopWorld = function (world) {
      topWorldC.set(world);
      if (player) player.setWorld(world);

      var name = persistencePool.getObjectName(world);
      if (name !== null) config.currentTopWorld.set(name);
    };
    this.getTopWorld = function () { return topWorldC.get(); };
    
    this.save = function () {
      persistencePool.flushAsync();
    };

    this.requestFullscreen = function () {
      input.requestFullscreen();
    };
    
    // Exposed for use by document
    this.config = config;
    this.ui = objectUI;

    // Exposed for debugging access
    this.pool = persistencePool;
    this.player = null;
  }
  
  cubes.Main = Main;
}());
