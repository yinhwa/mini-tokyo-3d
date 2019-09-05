/*
 * Copyright 2019 Akihiko Kusanagi
 *
 *    Licensed under the Apache License, Version 2.0 (the "License");
 *    you may not use this file except in compliance with the License.
 *    You may obtain a copy of the License at
 *
 *        http://www.apache.org/licenses/LICENSE-2.0
 *
 *    Unless required by applicable law or agreed to in writing, software
 *    distributed under the License is distributed on an "AS IS" BASIS,
 *    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *    See the License for the specific language governing permissions and
 *    limitations under the License.
 *
 * More information about this project is available at:
 *
 *    https://github.com/nagix/mini-tokyo-3d
 */

// API URL
var API_URL = 'https://api-tokyochallenge.odpt.org/api/v4/';

// API Token
var API_TOKEN = 'acl:consumerKey=772cd76134e664fb9ee7dbf0f99ae25998834efee29febe782b459f48003d090';

var SQRT3 = Math.sqrt(3);

var modelOrigin = mapboxgl.MercatorCoordinate.fromLngLat([139.7670, 35.6814]);
var modelScale = 1 / 2 / Math.PI / 6378137 / Math.cos(35.6814 * Math.PI / 180);

var isUndergroundVisible = false;
var opacityStore = {};
var featureLookup = {};
var stationLookup, railwayLookup;

// Replace MapboxLayer.render to support underground rendering
var render = MapboxLayer.prototype.render;
MapboxLayer.prototype.render = function(gl, matrix) {
	var deck = this.deck;
	var map = this.map;
	var center = map.getCenter();

	if (!deck.props.userData.currentViewport) {
		deck.props.userData.currentViewport = new WebMercatorViewport({
			x: 0,
			y: 0,
			width: deck.width,
			height: deck.height,
			longitude: center.lng,
			latitude: center.lat,
			zoom: map.getZoom(),
			bearing: map.getBearing(),
			pitch: map.getPitch(),
			nearZMultiplier: 0,
			farZMultiplier: 10
		});
	}
	render.apply(this, arguments);
};

var MapboxGLButtonControl = function(options) {
	this.initialize(options);
};

MapboxGLButtonControl.prototype.initialize = function(options) {
	this._className = options.className || '';
	this._title = options.title || '';
	this._eventHandler = options.eventHandler;
};

MapboxGLButtonControl.prototype.onAdd = function(map) {
	this._btn = document.createElement('button');
	this._btn.className = 'mapboxgl-ctrl-icon ' + this._className;
	this._btn.type = 'button';
	this._btn.title = this._title;
	this._btn.onclick = this._eventHandler;

	this._container = document.createElement('div');
	this._container.className = 'mapboxgl-ctrl-group mapboxgl-ctrl';
	this._container.appendChild(this._btn);

	return this._container;
};

MapboxGLButtonControl.prototype.onRemove = function() {
	this._container.parentNode.removeChild(this._container);
	this._map = undefined;
};

Promise.all([
	loadJSON('data/railways-coordinates.json'),
	loadJSON('data/stations.json'),
	loadJSON(API_URL + 'odpt:Railway?odpt:operator=odpt.Operator:JR-East,odpt.Operator:TokyoMetro,odpt.Operator:Toei&' + API_TOKEN),
	loadJSON(API_URL + 'odpt:Station?odpt:operator=odpt.Operator:JR-East,odpt.Operator:JR-Central,odpt.Operator:TWR&' + API_TOKEN),
	loadJSON(API_URL + 'odpt:Station?odpt:operator=odpt.Operator:TokyoMetro,odpt.Operator:Toei,odpt.Operator:Tobu,odpt.Operator:ToyoRapid,odpt.Operator:Keikyu,odpt.Operator:Keisei,odpt.Operator:Hokuso,odpt.Operator:Shibayama&' + API_TOKEN)
]).then(function([
	railwayData, stationData, railwayRefData, stationRefData1, stationRefData2
]) {

var stationRefData = stationRefData1.concat(stationRefData2);

var map = new mapboxgl.Map({
	container: 'map',
	style: 'data/osm-liberty.json',
	attributionControl: true,
	hash: true,
	center: [139.7670, 35.6814],
	zoom: 14,
	pitch: 60
});

stationLookup = buildLookup(stationRefData);
railwayLookup = buildLookup(railwayRefData);

// Update railway lookup dictionary
railwayData.railways.forEach(function(railway) {
	var id = railway['odpt:railway'];
	var railwayRef = railwayLookup[id];
	var stationOrder = railwayRef['odpt:stationOrder'];

	if (id === 'odpt.Railway:JR-East.Tokaido') {
		stationOrder = stationOrder.slice(0, 7);
	} else if (id === 'odpt.Railway:JR-East.Utsunomiya') {
		stationOrder = stationOrder.slice(0, 13);
	} else if (id === 'odpt.Railway:JR-East.Takasaki') {
		stationOrder = stationOrder.slice(0, 13);
	} else if (id === 'odpt.Railway:JR-East.Yokosuka') {
		stationOrder = stationOrder.slice(0, 11);
	}
	railwayRef._stations = stationOrder.map(function(station) {
		return station['odpt:station'];
	});
	merge(railwayRef['odpt:railwayTitle'], railway['odpt:railwayTitle']);
	railwayRef._color = railway._color;
	railwayRef._altitude = railway._altitude;
});

var railwayFeatureArray = [];

[13, 14, 15, 16, 17, 18].forEach(function(zoom) {
	var unit = Math.pow(2, 14 - zoom) * .1;

	railwayData.railways.forEach(function(railway) {
		var id = railway['odpt:railway'];
		var sublines = railway._sublines;
		var railwayFeature = turf.lineString(concat(sublines.map(function(subline) {
			var overlap = subline['odpt:railway'];
			var feature, offset;

			if (overlap) {
				feature = turf.lineSlice(subline.start, subline.end, featureLookup[overlap + '.' + zoom]);
				offset = subline.offset;

				if (offset) {
					feature = lineOffset(feature, offset * unit);
				}

				// Rewind if the overlap line is in opposite direction
				if (subline.reverse) {
					turf.getCoords(feature).reverse();
				}

				subline.feature = feature;
			}

			return subline;
		}).map(function(subline, i) {
			var interpolate, coordinates, feature1, feature2, length1, length2, coord1, coord2, f, nextSubline;

			function smoothCoords(reverse) {
				var start = !reverse ? 0 : coordinates.length - 1;
				var end = !reverse ? coordinates.length - 1 : 0;
				var step = !reverse ? 1 : -1;
				var feature = featureLookup[nextSubline['odpt:railway'] + '.' + zoom];
				var nearest = getNearestPointProperties(feature, coordinates[start]);
				var baseOffset = nextSubline.offset * unit - nearest.distance;
				var baseFeature = turf.lineString(coordinates);
				var baseLocation = getLocationAlongLine(baseFeature, coordinates[start]);
				var transition = Math.abs(nextSubline.offset) * .5 + .5;
				var factors = [];
				var j, distance;

				for (j = start; j !== end; j += step) {
					distance = Math.abs(getLocationAlongLine(baseFeature, coordinates[j]) - baseLocation);
					if (distance > transition) {
						break;
					}
					factors[j] = easeInOutQuad(1 - distance / transition);
				}
				for (j = start; j !== end && factors[j] > 0; j += step) {
					coordinates[j] = turf.getCoord(turf.destination(
						coordinates[j], baseOffset * factors[j], nearest.bearing
					));
				}
			}

			if (!subline['odpt:railway']) {
				interpolate = subline.interpolate;
				if (interpolate) {
					coordinates = [];
					feature1 = lineOffset(turf.lineSlice(
						sublines[i - 1].end,
						sublines[i + 1].start,
						featureLookup[sublines[i - 1]['odpt:railway'] + '.' + zoom]
					), sublines[i - 1].offset * unit);
					feature2 = lineOffset(turf.lineSlice(
						sublines[i - 1].end,
						sublines[i + 1].start,
						featureLookup[sublines[i + 1]['odpt:railway'] + '.' + zoom]
					), sublines[i + 1].offset * unit);
					length1 = turf.length(feature1);
					length2 = turf.length(feature2);
					for (j = 1; j < interpolate; j++) {
						coord1 = turf.getCoord(turf.along(feature1, length1 * (!sublines[i - 1].reverse ? j : interpolate - j) / interpolate));
						coord2 = turf.getCoord(turf.along(feature2, length2 * (!sublines[i + 1].reverse ? j : interpolate - j) / interpolate));
						f = easeInOutQuad(j / interpolate);
						coordinates.push([
							coord1[0] * (1 - f) + coord2[0] * f,
							coord1[1] * (1 - f) + coord2[1] * f
						]);
					}
				} else {
					coordinates = subline.coordinates.map(function(d) { return d.slice(); });
					nextSubline = sublines[i - 1];
					if (nextSubline && nextSubline['odpt:railway']) {
						smoothCoords();
					}
					nextSubline = sublines[i + 1];
					if (nextSubline && nextSubline['odpt:railway']) {
						smoothCoords(true);
					}
				}
				subline.feature = turf.lineString(coordinates);
			}

			return turf.getCoords(subline.feature);
		})), {color: railway._color, width: 8});

		if (railway._altitude < 0) {
			setAltitude(railwayFeature, -unit);
		}

		railwayFeature.properties.id = id + '.' + zoom;
		railwayFeature.properties.zoom = zoom;
		railwayFeature.properties.type = 0;
		railwayFeature.properties.altitude = railway._altitude || 0;

		// Set station offsets
		railwayFeature.properties['station-offsets'] = railwayLookup[id]._stations.map(function(station, i, stations) {
			var stationRef = stationLookup[station];

			// If the line has a loop, the last offset must be set explicitly
			// Otherwise, the location of the last station goes wrong
			return railway._loop && i === stations.length - 1 ?
				turf.length(railwayFeature) :
				getLocationAlongLine(railwayFeature, [stationRef['geo:long'], stationRef['geo:lat']]);
		});

		railwayFeatureArray.push(railwayFeature);
		featureLookup[id + '.' + zoom] = railwayFeature;
	});

	stationData.stations.forEach(function(station) {
		var coords = station.aliases.map(function(s) {
			var stationRef = stationLookup[s];
			var feature = featureLookup[stationRef['odpt:railway'] + '.' + zoom];
			return turf.getCoord(turf.nearestPointOnLine(feature, [stationRef['geo:long'], stationRef['geo:lat']]));
		});
		var properties = {outlineColor: '#000000', width: 4, color: '#FFFFFF'};
		var feature = turf.buffer(
			coords.length === 1 ? turf.point(coords[0], properties) : turf.lineString(coords, properties),
			unit
		);

		if (station.altitude < 0) {
			setAltitude(feature, -unit);
		}

		feature.properties.zoom = zoom;
		feature.properties.type = 1;
		feature.properties.altitude = station.altitude || 0;

		railwayFeatureArray.push(feature);
	});
});

var railwayFeatureCollection = turf.featureCollection(railwayFeatureArray);

map.once('load', function () {
	document.getElementById('loader').style.display = 'none';
});

map.once('styledata', function () {
	map.getStyle().layers.forEach(function(layer) {
		if (layer.type === 'symbol') {
			map.setLayoutProperty(layer.id, 'visibility', 'none');
		}
	});

	[13, 14, 15, 16, 17, 18].forEach(function(zoom) {
		var minzoom = zoom <= 13 ? 0 : zoom;
		var maxzoom = zoom >= 18 ? 24 : zoom + 1;
		var lineWidthScale = zoom === 13 ? clamp(Math.pow(2, map.getZoom() - 12), .125, 1) : 1;

		map.addLayer(new MapboxLayer({
			id: 'railways-ug-' + zoom,
			type: GeoJsonLayer,
			data: filterFeatures(railwayFeatureCollection, function(p) {
				return p.zoom === zoom && p.type === 0 && p.altitude === -1;
			}),
			filled: false,
			stroked: true,
			getLineWidth: function(d) {
				return d.properties.width;
			},
			getLineColor: function(d) {
				return colorToRGBArray(d.properties.color);
			},
			lineWidthUnits: 'pixels',
			lineWidthScale: lineWidthScale,
			lineJointRounded: true,
			opacity: .0625
		}), 'building-3d');
		map.setLayerZoomRange('railways-ug-' + zoom, minzoom, maxzoom);
		map.addLayer(new MapboxLayer({
			id: 'stations-ug-' + zoom,
			type: GeoJsonLayer,
			data: filterFeatures(railwayFeatureCollection, function(p) {
				return p.zoom === zoom && p.type === 1 && p.altitude === -1;
			}),
			filled: true,
			stroked: true,
			getLineWidth: 4,
			getLineColor: [0, 0, 0],
			lineWidthUnits: 'pixels',
			lineWidthScale: lineWidthScale,
			getFillColor: [255, 255, 255, 179],
			opacity: .0625
		}), 'building-3d');
		map.setLayerZoomRange('stations-ug-' + zoom, minzoom, maxzoom);
	});

	[13, 14, 15, 16, 17, 18].forEach(function(zoom) {
		var minzoom = zoom <= 13 ? 0 : zoom;
		var maxzoom = zoom >= 18 ? 24 : zoom + 1;
		var getWidth = ['get', 'width'];
		var lineWidth = zoom === 13 ?
			['interpolate', ['exponential', 2], ['zoom'], 9, ['/', getWidth, 8], 12, getWidth] : getWidth;

		map.addLayer({
			id: 'railways-og-' + zoom,
			type: 'line',
			source: {
				type: 'geojson',
				data: filterFeatures(railwayFeatureCollection, function(p) {
					return p.zoom === zoom && p.type === 0 && p.altitude === 0;
				})
			},
			paint: {
				'line-color': ['get', 'color'],
				'line-width': lineWidth
			},
			minzoom: minzoom,
			maxzoom: maxzoom
		}, 'building-3d');
		map.addLayer({
			id: 'stations-og-' + zoom,
			type: 'fill',
			source: {
				type: 'geojson',
				data: filterFeatures(railwayFeatureCollection, function(p) {
					return p.zoom === zoom && p.type === 1 && p.altitude === 0;
				})
			},
			paint: {
				'fill-color': ['get', 'color'],
				'fill-opacity': .7
			},
			minzoom: minzoom,
			maxzoom: maxzoom
		}, 'building-3d');
		map.addLayer({
			id: 'stations-outline-og-' + zoom,
			type: 'line',
			source: {
				type: 'geojson',
				data: filterFeatures(railwayFeatureCollection, function(p) {
					return p.zoom === zoom && p.type === 1 && p.altitude === 0;
				})
			},
			paint: {
				'line-color': ['get', 'outlineColor'],
				'line-width': lineWidth
			},
			minzoom: minzoom,
			maxzoom: maxzoom
		}, 'building-3d');
	});

	map.getStyle().layers.filter(function(layer) {
		return layer.type === 'line' || layer.type.lastIndexOf('fill', 0) !== -1;
	}).forEach(function(layer) {
		opacityStore[layer.id] = map.getPaintProperty(layer.id, layer.type + '-opacity') || 1;
	});

	map.addControl(new mapboxgl.NavigationControl());

	control = new mapboxgl.FullscreenControl();
	control._updateTitle = function() {
		mapboxgl.FullscreenControl.prototype._updateTitle.apply(this,arguments);
		this._fullscreenButton.title = (this._isFullscreen() ? 'Exit' : 'Enter') + ' fullscreen';
	}
	map.addControl(control);

	map.addControl(new MapboxGLButtonControl({
		className: 'mapbox-ctrl-underground',
		title: 'Enter underground',
		eventHandler: function(event) {
			isUndergroundVisible = !isUndergroundVisible;
			this.title = (isUndergroundVisible ? 'Exit' : 'Enter') + ' underground';
			if (isUndergroundVisible) {
				this.classList.add('mapbox-ctrl-underground-visible');
				map.setPaintProperty('background', 'background-color', 'rgb(16,16,16)');
			} else {
				this.classList.remove('mapbox-ctrl-underground-visible');
				map.setPaintProperty('background', 'background-color', 'rgb(239,239,239)');
			}
			map.getStyle().layers.forEach(function(layer) {
				var id = layer.id;
				var opacity = opacityStore[id];
				if (opacity !== undefined) {
					if (isUndergroundVisible) {
						opacity *= id.indexOf('-og-') !== -1 ? .25 : .0625;
					}
					map.setPaintProperty(id, layer.type + '-opacity', opacity);
				}
			});

			var start = performance.now();
			function repeat() {
				var t = Math.min((performance.now() - start) / 300, 1);
				[13, 14, 15, 16, 17, 18].forEach(function(zoom) {
					var opacity = isUndergroundVisible ?
						1 * t + .0625 * (1 - t) : 1 * (1 - t) + .0625 * t;

					setLayerProps(map, 'stations-ug-' + zoom, {opacity: opacity});
					setLayerProps(map, 'railways-ug-' + zoom, {opacity: opacity});
				});
				if (t < 1) {
					requestAnimationFrame(repeat);
				}
			}
			repeat();
		}
	}), 'top-right');

	map.addControl(new MapboxGLButtonControl({
		className: 'mapbox-ctrl-export',
		title: 'Export',
		eventHandler: function() {
			var link = document.createElement('a');
			link.download = 'features.json';
			link.href = 'data:application/json,' + encodeURIComponent(JSON.stringify(turf.truncate(railwayFeatureCollection, {precision: 7})));
			link.dispatchEvent(new MouseEvent('click'));
		}
	}), 'top-right');

	map.on('click', function(e) {
		console.log(e.lngLat);
	});

	map.on('zoom', function() {
		var lineWidthScale = clamp(Math.pow(2, map.getZoom() - 12), .125, 1);

		setLayerProps(map, 'railways-ug-13', {lineWidthScale: lineWidthScale});
		setLayerProps(map, 'stations-ug-13', {lineWidthScale: lineWidthScale});
	});
});

});

function colorToRGBArray(color) {
	var c = parseInt(color.replace('#', ''), 16);
	return [Math.floor(c / 65536) % 256, Math.floor(c / 256) % 256, c % 256, 255];
}

function setAltitude(geojson, altitude) {
	turf.coordEach(geojson, function(coord) {
		coord[2] = altitude * 1000;
	});
}

function getNearestPointProperties(line, point) {
	var nearestPoint = turf.nearestPointOnLine(line, point);
	var properties = nearestPoint.properties;
	var coords = turf.getCoords(line);
	var index = Math.min(properties.index, coords.length - 2);
	var lineBearing = turf.bearing(coords[index], coords[index + 1]);
	var bearing = turf.bearing(nearestPoint, point);
	var sign = getAngle(lineBearing, bearing) >= 0 ? 1 : -1;

	return {
		point: nearestPoint,
		bearing: bearing + (1 - sign) * 90,
		distance: properties.dist * sign
	}
}

function getLocationAlongLine(line, point) {
	var nearestPoint = turf.nearestPointOnLine(line, point);
	return nearestPoint.properties.location;
}

function getAngle(bearing1, bearing2) {
    var angle = bearing2 - bearing1;

    if (angle > 180) {
        angle -= 360;
    } else if (angle < -180) {
        angle += 360;
    }
    return angle;
}

// Better version of turf.lineOffset
function lineOffset(geojson, distance) {
	var coords = turf.getCoords(geojson);
	var coordsLen = coords.length;
	var start = coords[0];
	var startBearing = turf.bearing(start, coords[2] || coords[1]);
	var end = coords[coordsLen - 1];
	var endBearing = turf.bearing(coords[coordsLen - 3] || coords[coordsLen - 2], end);
	var bearingOffset = distance > 0 ? 90 : -90;

	// Converting meters to Mercator meters
	var dist = Math.abs(distance / Math.cos((start[1] + end[1]) * Math.PI / 360));
	var polygonLine = turf.polygonToLine(
		turf.buffer(geojson, dist, {step: coordsLen * 2 + 64})
	);
	var polygonLineCoords = turf.getCoords(polygonLine);
	var length = polygonLineCoords.length;
	var p0 = turf.nearestPointOnLine(polygonLine, turf.destination(start, dist, startBearing + 180));
	var tempCoords = [];
	var step = distance > 0 ? -1 : 1;
	var i;

	// First, rotate coordinates
	for (i = 0; i < length; i++) {
		tempCoords.push(polygonLineCoords[(p0.properties.index + i * step + length) % length]);
	}

	// Then, slice the line
	var p1 = turf.nearestPointOnLine(polygonLine, turf.destination(start, dist, startBearing + bearingOffset));
	var p2 = turf.nearestPointOnLine(polygonLine, turf.destination(end, dist, endBearing + bearingOffset));

	return turf.lineSlice(p1, p2, turf.lineString(tempCoords));
}

function filterFeatures(featureCollection, fn) {
	return turf.featureCollection(featureCollection.features.filter(function(feature) {
		return fn(feature.properties);
	}));
}

function setLayerProps(map, id, props) {
	map.getLayer(id).implementation.setProps(props);
}

function easeInOutQuad(t) {
	if ((t /= 0.5) < 1) {
		return 0.5 * t * t;
	}
	return -0.5 * ((--t) * (t - 2) - 1);
}

function concat(arr) {
	return Array.prototype.concat.apply([], arr);
}

function merge(target, source) {
	if (target === undefined || source === undefined) {
		return;
	}
	Object.keys(source).forEach(function(key) {
		target[key] = source[key];
	});
	return target;
}

function clamp(value, lower, upper) {
	return Math.min(Math.max(value, lower), upper);
}

function loadJSON(url) {
	return new Promise(function(resolve, reject) {
		var request = new XMLHttpRequest();

		request.open('GET', url);
		request.onreadystatechange = function() {
			if (request.readyState === 4) {
				if (request.status === 200) {
					resolve(JSON.parse(request.response));
				} else {
					reject(Error(request.statusText));
				}
			}
		}
		request.send();
	});
}

function buildLookup(array, key) {
	var lookup = {};

	key = key || 'owl:sameAs';
	array.forEach(function(element) {
		lookup[element[key]] = element;
	});
	return lookup;
}
