/*******************************************************************************

    µBlock - a Chromium browser extension to black/white list requests.
    Copyright (C) 2014  Raymond Hill

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see {http://www.gnu.org/licenses/}.

    Home: https://github.com/gorhill/uBlock
*/

/* global punycode, µBlock */
/* jshint bitwise: false */

/******************************************************************************/

µBlock.dynamicNetFilteringEngine = (function() {

/******************************************************************************/

var magicId = 'chmdgxwtetgu';

/******************************************************************************/

var Matrix = function() {
    this.reset();
};

/******************************************************************************/

var typeBitOffsets = {
            '*':  0,
'inline-script':  2,
    '1p-script':  4,
    '3p-script':  6,
     '3p-frame':  8,
        'image': 10
};

var stateToNameMap = {
    '1': 'block',
    '2': 'allow',
    '3': 'noop'
};

var nameToStateMap = {
    'block': 1,
    'allow': 2,
     'noop': 3
};

/******************************************************************************/

// For performance purpose, as simple tests as possible
var reHostnameVeryCoarse = /[g-z_-]/;
var reIPv4VeryCoarse = /\.\d+$/;

// http://tools.ietf.org/html/rfc5952
// 4.3: "MUST be represented in lowercase"
// Also: http://en.wikipedia.org/wiki/IPv6_address#Literal_IPv6_addresses_in_network_resource_identifiers

var isIPAddress = function(hostname) {
    if ( reHostnameVeryCoarse.test(hostname) ) {
        return false;
    }
    if ( reIPv4VeryCoarse.test(hostname) ) {
        return true;
    }
    return hostname.charAt(0) === '[';
};

/******************************************************************************/

var toBroaderHostname = function(hostname) {
    if ( hostname === '*' ) {
        return '';
    }
    if ( isIPAddress(hostname) ) {
        return '*';
    }
    var pos = hostname.indexOf('.');
    if ( pos === -1 ) {
        return '*';
    }
    return hostname.slice(pos + 1);
};

Matrix.toBroaderHostname = toBroaderHostname;

/******************************************************************************/

Matrix.prototype.reset = function() {
    this.r = 0;
    this.type = '';
    this.y = '';
    this.z = '';
    this.rules = {};
};

/******************************************************************************/

Matrix.prototype.setCell = function(srcHostname, desHostname, type, state) {
    var bitOffset = typeBitOffsets[type];
    var k = srcHostname + ' ' + desHostname;
    var oldBitmap = this.rules[k];
    if ( oldBitmap === undefined ) {
        oldBitmap = 0;
    }
    var newBitmap = oldBitmap & ~(3 << bitOffset) | (state << bitOffset);
    if ( newBitmap === oldBitmap ) {
        return false;
    }
    if ( newBitmap === 0 ) {
        delete this.rules[k];
    } else {
        this.rules[k] = newBitmap;
    }
    return true;
};

/******************************************************************************/

Matrix.prototype.unsetCell = function(srcHostname, desHostname, type) {
    this.evaluateCellZY(srcHostname, desHostname, type);
    if ( this.r === 0 ) {
        return false;
    }
    this.setCell(srcHostname, desHostname, type, 0);
    return true;
};

/******************************************************************************/

Matrix.prototype.setCellZ = function(srcHostname, desHostname, type, action) {
    this.evaluateCellZY(srcHostname, desHostname, type);
    if ( this.r === action ) {
        return false;
    }
    this.setCell(srcHostname, desHostname, type, 0);
    this.evaluateCellZY(srcHostname, desHostname, type);
    if ( this.r === action ) {
        return true;
    }
    this.setCell(srcHostname, desHostname, type, action);
    return true;
};

/******************************************************************************/

Matrix.prototype.blockCell = function(srcHostname, desHostname, type) {
    return this.setCellZ(srcHostname, desHostname, type, 1);
};

// https://www.youtube.com/watch?v=Csewb_eIStY

/******************************************************************************/

Matrix.prototype.allowCell = function(srcHostname, desHostname, type) {
    return this.setCellZ(srcHostname, desHostname, type, 2);
};

/******************************************************************************/

Matrix.prototype.evaluateCell = function(srcHostname, desHostname, type) {
    var key = srcHostname + ' ' + desHostname;
    var bitmap = this.rules[key];
    if ( bitmap === undefined ) {
        return 0;
    }
    return bitmap >> typeBitOffsets[type] & 3;
};

/******************************************************************************/

Matrix.prototype.clearRegisters = function() {
    this.r = 0;
    this.type = '';
    this.y = '';
    this.z = '';
};

/******************************************************************************/

Matrix.prototype.evaluateCellZ = function(srcHostname, desHostname, type) {
    var bitOffset = typeBitOffsets[type];
    var s = srcHostname;
    var v;
    for (;;) {
        this.z = s;
        v = this.rules[s + ' ' + desHostname];
        if ( v !== undefined ) {
            v = v >> bitOffset & 3;
            if ( v !== 0 ) {
                return v;
            }
        }
        s = toBroaderHostname(s);
        if ( s === '' ) {
            break;
        }
    }
    // srcHostname is '*' at this point
    return 0;
};

/******************************************************************************/

Matrix.prototype.evaluateCellZY = function(srcHostname, desHostname, type) {
    if ( typeBitOffsets.hasOwnProperty(type) === false ) {
        this.type = '';
        this.r = 0;
        return this;
    }
    this.type = type;
    // Specific-hostname specific-type cell
    this.y = desHostname;
    this.r = this.evaluateCellZ(srcHostname, desHostname, type);
    if ( this.r !== 0 ) { return this; }

    var d = desHostname;
    for (;;) {
        d = toBroaderHostname(d);
        if ( d === '*' ) {
            break;
        }
        // specific-hostname specific-type cell
        this.y = d;
        this.r = this.evaluateCellZ(srcHostname, d, type);
        if ( this.r !== 0 ) { return this; }
    }

    // Any-hostname specific-type cells
    this.y = '*';
    this.r = this.evaluateCellZ(srcHostname, '*', type);
    return this;
};

// http://youtu.be/gSGk1bQ9rcU?t=25m6s

/******************************************************************************/

Matrix.prototype.mustBlockOrAllow = function() {
    return this.r === 1 || this.r === 2;
};

/******************************************************************************/

Matrix.prototype.mustAbort = function() {
    return this.r === 3;
};

/******************************************************************************/

Matrix.prototype.toFilterString = function() {
    if ( this.type === '' ) {
        return '';
    }
    if ( this.r === 1 ) {
        return 'db:' + this.z + ' ' + this.y + ' ' + this.type + ' block';
    }
    if ( this.r === 2 ) {
        return 'da:' + this.z + ' ' + this.y + ' ' + this.type + ' allow';
    }
    if ( this.r === 3 ) {
        return 'dn:' + this.z + ' ' + this.y + ' ' + this.type + ' noop';
    }
    return '';
};

/******************************************************************************/

Matrix.prototype.mustBlock = function(srcHostname, desHostname, type) {
    this.evaluateCellZY(srcHostname, desHostname, type);
    return this.r === 1;
};

/******************************************************************************/

Matrix.prototype.srcHostnameFromRule = function(rule) {
    return rule.slice(0, rule.indexOf(' '));
};

/******************************************************************************/

Matrix.prototype.desHostnameFromRule = function(rule) {
    return rule.slice(rule.indexOf(' ') + 1);
};

/******************************************************************************/

Matrix.prototype.toString = function() {
    var out = [];
    var rule, type, val;
    var srcHostname, desHostname;
    for ( rule in this.rules ) {
        if ( this.rules.hasOwnProperty(rule) === false ) {
            continue;
        }
        srcHostname = this.srcHostnameFromRule(rule);
        desHostname = this.desHostnameFromRule(rule);
        for ( type in typeBitOffsets ) {
            if ( typeBitOffsets.hasOwnProperty(type) === false ) {
                continue;
            }
            val = this.evaluateCell(srcHostname, desHostname, type);
            if ( val === 0 ) {
                continue;
            }
            out.push(
                punycode.toUnicode(srcHostname) + ' ' +
                punycode.toUnicode(desHostname) + ' ' +
                type + ' ' +
                stateToNameMap[val]
            );
        }
    }
    return out.join('\n');
};

/******************************************************************************/

Matrix.prototype.fromString = function(text, append) {
    var textEnd = text.length;
    var lineBeg = 0, lineEnd;
    var line, pos;
    var fields, fieldVal;
    var srcHostname = '';
    var desHostname = '';
    var type, state;

    while ( lineBeg < textEnd ) {
        lineEnd = text.indexOf('\n', lineBeg);
        if ( lineEnd < 0 ) {
            lineEnd = text.indexOf('\r', lineBeg);
            if ( lineEnd < 0 ) {
                lineEnd = textEnd;
            }
        }
        line = text.slice(lineBeg, lineEnd).trim();
        lineBeg = lineEnd + 1;

        pos = line.indexOf('# ');
        if ( pos !== -1 ) {
            line = line.slice(0, pos).trim();
        }
        if ( line === '' ) {
            continue;
        }

        fields = line.split(/\s+/);

        // Less than 2 fields makes no sense
        if ( fields.length < 2 ) {
            continue;
        }

        fieldVal = fields[0];

        // Valid rule syntax:

        // srcHostname desHostname [type [state]]
        //      type = a valid request type
        //      state = [`block`, `allow`, `inherit`]

        // srcHostname desHostname type
        //      type = a valid request type
        //      state = `allow`

        // srcHostname desHostname
        //      type = `*`
        //      state = `allow`

        // Lines with invalid syntax silently ignored

        srcHostname = punycode.toASCII(fields[0]);
        desHostname = punycode.toASCII(fields[1]);

        fieldVal = fields[2];

        if ( fieldVal !== undefined ) {
            type = fieldVal;
            // Unknown type: reject
            if ( typeBitOffsets.hasOwnProperty(type) === false ) {
                continue;
            }
        } else {
            type = '*';
        }

        fieldVal = fields[3];

        if ( fieldVal !== undefined ) {
            // Unknown state: reject
            if ( nameToStateMap.hasOwnProperty(fieldVal) === false ) {
                continue;
            }
            state = nameToStateMap[fieldVal];
        } else {
            state = 2;
        }

        this.setCell(srcHostname, desHostname, type, state);
    }
};

/******************************************************************************/

Matrix.prototype.fromObsoleteSelfie = function(selfie) {
    if ( selfie === '' ) {
        return '';
    }
    var bin = JSON.parse(selfie);
    var filters = bin.filters;
    var bits, val;
    for ( var hostname in filters ) {
        if ( filters.hasOwnProperty(hostname) === false ) {
            continue;
        }
        bits = filters[hostname];
        val = bits & 3;
        if ( val === 1 ) {
            this.setCell(hostname, '*', 'inline-script', 1);
        } else if ( val === 2 ) {
            this.setCell(hostname, '*', 'inline-script', 3);
        }
        val = (bits >> 2) & 3;
        if ( val === 1 ) {
            this.setCell(hostname, '*', '1p-script', 1);
        } else if ( val === 2 ) {
            this.setCell(hostname, '*', '1p-script', 3);
        }
        val = (bits >> 4) & 3;
        if ( val === 1 ) {
            this.setCell(hostname, '*', '3p-script', 1);
        } else if ( val === 2 ) {
            this.setCell(hostname, '*', '3p-script', 3);
        }
        val = (bits >> 8) & 3;
        if ( val === 1 ) {
            this.setCell(hostname, '*', '3p-frame', 1);
        } else if ( val === 2 ) {
            this.setCell(hostname, '*', '3p-frame', 3);
        }
    }
};

/******************************************************************************/

Matrix.prototype.toSelfie = function() {
    return {
        magicId: magicId,
        rules: this.rules
    };
};

/******************************************************************************/

Matrix.prototype.fromSelfie = function(selfie) {
    this.rules = selfie.rules;
};

/******************************************************************************/

return new Matrix;

/******************************************************************************/

// http://youtu.be/5-K8R1hDG9E?t=31m1s

})();

/******************************************************************************/
