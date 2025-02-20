import angular from 'angular'
import _ from 'lodash'


export class PiWebApiDatasource {
  /**
   * Creates an instance of PiWebApiDatasource.
   * 
   * @param {any} instanceSettings - Settings from admin page.
   * @param {any} backendSrv - Grafana backend web communications.
   * @param {any} templateSrv - Grafana template server.
   * @param {any} $q - Angular async/promise helper.
   * @param {any} $cacheFactory - A cache for PI Web API webids for element paths.
   * 
   * @memberOf PiWebApiDatasource
   */
  constructor (instanceSettings, backendSrv, templateSrv, $q, $cacheFactory) {
    this.$q = $q
    this.backendSrv = backendSrv
    this.templateSrv = templateSrv
    this.webidCache = $cacheFactory.get('piWebApiIds') || $cacheFactory('piWebApiIds')

    this.type = instanceSettings.type
    this.url = instanceSettings.url.toString()
    this.piwebapiurl = instanceSettings.jsonData.url.toString()
    this.isProxy = /^http(s)?:\/\//.test(this.url) || instanceSettings.jsonData.access === 'proxy';

    this.name = instanceSettings.name
    this.piserver = {name: (instanceSettings.jsonData || {}).piserver, webid: null}
    this.afserver = {name: (instanceSettings.jsonData || {}).afserver, webid: null}
    this.afdatabase = {name: (instanceSettings.jsonData || {}).afdatabase, webid: null}

    this.getAssetServer(this.afserver.name).then(result => { this.afserver.webid = result.WebId })
    this.getDataServer(this.piserver.name).then(result => { this.piserver.webid = result.WebId })
    this.getDatabase(this.afserver.name + '\\' + this.afdatabase.name).then(result => { this.afdatabase.webid = result.WebId })
  }

  /**
   * Converts a PIWebAPI Event Frame response to a Grafana Annotation
   * 
   * @param {any} annotationOptions - Options data from configuration panel.
   * @param {any} endTime - End time of the Event Frame.
   * @param {any} eventFrame - The Event Frame data.
   * @returns - Grafana Annotation
   * 
   * @memberOf PiWebApiDatasource
   */
  eventFrameToAnnotation (annotationOptions, endTime, eventFrame, attributeDataItems) {
    if (annotationOptions.regex && annotationOptions.regex.enable) {
      eventFrame.Name = eventFrame.Name.replace(new RegExp(annotationOptions.regex.search), annotationOptions.regex.replace)
    }

    var attributeText = ''
    if (attributeDataItems) {
      _.each(attributeDataItems, (attributeData) => {
        const attributeValue = attributeData.Value.Value ? attributeData.Value.Value.Name || attributeData.Value.Value.Value || attributeData.Value.Value : null
        attributeText += ('<br />' + attributeData.Name + ': ' + attributeValue)
      })
    }
    return {
      annotation: annotationOptions,
      title: (endTime ? 'END ' : annotationOptions.showEndTime ? 'START ' : '') + annotationOptions.name,
      time: new Date(endTime ? eventFrame.EndTime : eventFrame.StartTime).getTime(),
      text: eventFrame.Name +
            attributeText +
            '<br />Start: ' + eventFrame.StartTime +
            '<br />End: ' + eventFrame.EndTime
      // tags: eventFrame.CategoryNames.join()
    }
  }

  /**
   * Builds the PIWebAPI query parameters.
   * 
   * @param {any} options - Grafana query and panel options.
   * @returns - PIWebAPI query parameters.
   * 
   * @memberOf PiWebApiDatasource
   */
  buildQueryParameters (options) {
    options.targets = _.filter(options.targets, target => {
      return (!target.target.startsWith('Select AF'))
    })

    options.targets = _.map(options.targets, target => {
      var tar = {
        target: this.templateSrv.replace(target.elementPath, options.scopedVars),
        elementPath: this.templateSrv.replace(target.elementPath, options.scopedVars),
        attributes: _.map(target.attributes, att => { return this.templateSrv.replace(att) }),
        display: target.display,
        refId: target.refId,
        hide: target.hide,
        interpolate: target.interpolate || {enable: false},
        recordedValues: target.recordedValues || {enable: false},
        digitalStates: target.digitalStates || {enable: false},
        webid: target.webid,
        webids: target.webids || [],
        regex: target.regex || {enable: false},
        expression: target.expression || '',
        summary: target.summary || {types: []},
        startTime: options.range.from.toJSON(),
        endTime: options.range.to.toJSON(),
        isPiPoint: target.isPiPoint
      }
      
      if (tar.expression) {
        tar.expression = this.templateSrv.replace(tar.expression);
      }

      if (tar.summary.types !== undefined) {
        tar.summary.types = _.filter(tar.summary.types, item => { return item !== undefined && item !== null && item !== '' })
      }

      return tar
    })

    return options
  }

  /**
   * Datasource Implementation. Primary entry point for data source.
   * This takes the panel configuration and queries, sends them to PI Web API and parses the response.
   * 
   * @param {any} options - Grafana query and panel options.
   * @returns - Promise of data in the format for Grafana panels.
   * 
   * @memberOf PiWebApiDatasource
   */
  query (options) {
    var ds = this

    var query = this.buildQueryParameters(options)
    query.targets = _.filter(query.targets, t => !t.hide)

    if (query.targets.length <= 0) {
      return this.$q.when({data: []})
    } else {
      return ds.$q.all(
        ds.getStream(query))
        .then(targetResponses => {
          var flattened = []
          _.each(targetResponses, tr => {
            _.each(tr, item => {
              flattened.push(item)
            })
          })
          return {data: flattened.sort((a, b) => { return +(a.target > b.target) || +(a.target === b.target) - 1 })}
        })
    }
  }

  /**
   * Alerting Implementation
   * 
   * @param {any} target
   * @returns - boolean alert status
   * 
   * @memberOf PiWebApiDatasource
   */
  targetContainsTemplate(target) {
    return this.templateSrv.variableExists(target.target);
  }
  
  /**
   * Datasource Implementation. 
   * Used for testing datasource in datasource configuration pange
   * 
   * @returns - Success or failure message.
   * 
   * @memberOf PiWebApiDatasource
   */
  testDatasource () {
    return this.backendSrv.datasourceRequest({
      url: this.url + '/',
      method: 'GET'
    }).then(response => {
      if (response.status === 200) {
        return { status: 'success', message: 'Data source is working', title: 'Success' }
      }
    })
  }

  /**
   * Datasource Implementation. 
   * This queries PI Web API for Event Frames and converts them into annotations.
   * 
   * @param {any} options - Annotation options, usually the Event Frame Category.
   * @returns - A Grafana annotation.
   * 
   * @memberOf PiWebApiDatasource
   */
  annotationQuery (options) {
    if (!this.afdatabase.webid) {
      return this.$q.when([])
    } 

    var categoryName = options.annotation.query.categoryName ? this.templateSrv.replace(options.annotation.query.categoryName, {}, 'glob') : null
    var nameFilter = options.annotation.query.nameFilter ? this.templateSrv.replace(options.annotation.query.nameFilter, {}, 'glob') : null
    var templateName = options.annotation.template ? options.annotation.template.Name : null
    var annotationOptions = {
      name: options.annotation.name,
      datasource: options.annotation.datasource,
      enable: options.annotation.enable,
      iconColor: options.annotation.iconColor,
      showEndTime: options.annotation.showEndTime,
      regex: options.annotation.regex,
      attribute: options.annotation.attribute,
      categoryName: categoryName,
      templateName: templateName,
      nameFilter: nameFilter
    }

    var filter = []
    if (!!annotationOptions.categoryName) {
      filter.push('categoryName=' + annotationOptions.categoryName)
    }
    if (!!annotationOptions.nameFilter) {
      filter.push('nameFilter=' + annotationOptions.nameFilter)
    }
    if (!!annotationOptions.templateName) {
      filter.push('templateName=' + annotationOptions.templateName)
    }
    if (!filter.length) {
      return this.$q.when([])
    }
    filter.push('startTime=' + options.range.from.toJSON())
    filter.push('endTime=' + options.range.to.toJSON())

    if (annotationOptions.attribute && annotationOptions.attribute.enable) {
      var resourceUrl = this.piwebapiurl +'/streamsets/{0}/value?selectedFields=Items.WebId;Items.Value;Items.Name'
      if (!!annotationOptions.attribute.name) {
        resourceUrl = this.piwebapiurl +'/streamsets/{0}/value?nameFilter=' + annotationOptions.attribute.name + '&selectedFields=Items.WebId;Items.Value;Items.Name'
      }
      var query = {}
      query["1"] = {
        'Method': 'GET',
        'Resource': this.piwebapiurl +'/assetdatabases/' + this.afdatabase.webid + '/eventframes?' + filter.join('&')
      },
      query["2"] = {
        'Method': 'GET',
        'RequestTemplate': {
          'Resource': resourceUrl,
        },
        'Parameters': [
            '$.1.Content.Items[*].WebId'
        ],
        'ParentIds': [
            '1'
        ]
      }
      return this.restBatch(query).then((result) => {
        const data = result.data["1"].Content
        const valueData = result.data["2"].Content

        var annotations = _.map(data.Items, (item, index) => {
          return _.curry(this.eventFrameToAnnotation)(annotationOptions, false, item, valueData.Items[index].Content.Items)
        })
  
        if (options.annotation.showEndTime) {
          var ends = _.map(data.Items, (item, index) => {
            return _.curry(this.eventFrameToAnnotation)(annotationOptions, true, item, valueData.Items[index].Content.Items)
          })
          _.each(ends, end => { annotations.push(end) })
        }
  
        return annotations
      })
    } else {
      return this.restGet('/assetdatabases/' + this.afdatabase.webid + '/eventframes?' + filter.join('&')).then(result => {
        var annotations = _.map(result.data.Items, _.curry(this.eventFrameToAnnotation)(annotationOptions, false))
  
        if (options.annotation.showEndTime) {
          var ends = _.map(result.data.Items, _.curry(this.eventFrameToAnnotation)(annotationOptions, true))
          _.each(ends, end => { annotations.push(end) })
        }
  
        return annotations
      })
    }
  }

  /**
   * Builds the Grafana metric segment for use on the query user interface.
   * 
   * @param {any} response - response from PI Web API.
   * @returns - Grafana metric segment.
   * 
   * @memberOf PiWebApiDatasource
   */
  metricQueryTransform (response) {
    return _.map(response, item => {
      return {
        text: item.Name,
        expandable: (item.HasChildren === undefined || item.HasChildren === true || item.Path.split('\\').length <= 3),
        Path: item.Path,
        WebId: item.WebId
      }
    })
  }

  /**
   * This method does the discovery of the AF Hierarchy and populates the query user interface segments.
   * 
   * @param {any} query - Parses the query configuration and builds a PI Web API query.
   * @returns - Segment information.
   * 
   * @memberOf PiWebApiDatasource
   */
  metricFindQuery (query, isPiPoint) {
    query = angular.fromJson(query)

    var ds = this
    var querydepth = ['servers', 'databases', 'databaseElements', 'elements']
    if (query.path === '') {
      query.type = querydepth[0]
    } else if (query.type !== 'attributes') {
      query.type = querydepth[Math.max(0, Math.min(query.path.split('\\').length, querydepth.length - 1))]
    }
    if (isPiPoint) {
      query.type = 'dataserver'
      
      if (query.webId !== undefined && query.webId !== '') {
        query.type = 'pipoint'
      }    
    }

    query.path = this.templateSrv.replace(query.path)

    if (query.type === 'servers') {
      return ds.getAssetServers()
        .then(ds.metricQueryTransform)
    } else if (query.type === 'databases') {
      return ds.getAssetServer(query.path)
        .then(server => {
          return ds.getDatabases(server.WebId, {})
            .then(ds.metricQueryTransform) })
    } else if (query.type === 'databaseElements') {
      return ds.getDatabase(query.path)
        .then(db => {
          return ds.getDatabaseElements(db.WebId, {selectedFields: 'Items.WebId;Items.Name;Items.Path;Item.HasChildren'})
            .then(ds.metricQueryTransform) })
    } else if (query.type === 'elements') {
      return ds.getElement(query.path)
        .then(element => {
          return ds.getElements(element.WebId, {selectedFields: 'Items.WebId;Items.Name;Items.Path;Item.HasChildren'})
            .then(ds.metricQueryTransform) })
    } else if (query.type === 'attributes') {
      return ds.getElement(query.path)
        .then(element => {
          return ds.getAttributes(element.WebId, {searchFullHierarchy: 'true', selectedFields: 'Items.WebId;Items.Name;Items.Path'})
            .then(ds.metricQueryTransform) })
    } else if (query.type === 'dataserver') {
      return ds.getDataServers()
        .then(ds.metricQueryTransform)
      } else if (query.type === 'pipoint') {
        return ds.piPointSearch(query.webId, query.pointName)
          .then(ds.metricQueryTransform)
      }
  }

  /**
   * Gets the url of summary data from the query configuration.
   * 
   * @param {any} summary - Query summary configuration.
   * @returns - URL append string.
   * 
   * @memberOf PiWebApiDatasource
   */
  getSummaryUrl (summary) {
    if (summary.interval == "") {
      return '&summaryType=' + summary.types.join('&summaryType=') +
            '&calculationBasis=' + summary.basis
    }
    return '&summaryType=' + summary.types.join('&summaryType=') +
            '&calculationBasis=' + summary.basis +
            '&summaryDuration=' + summary.interval
  }

  /**
   * Resolve a Grafana query into a PI Web API webid. Uses client side cache when possible to reduce lookups.
   * 
   * @param {any} query - Grafana query configuration.
   * 
   * @memberOf PiWebApiDatasource
   */
  resolveWebIds (query) {
    var ds = this
    var batchQuery = {}
    var batchIndex = 1

    _.each(query.targets, target => {
      var hasAttributes = target.attributes.length > 0

      var elementBatchId = batchIndex++
      batchQuery[elementBatchId.toString()] = {
        'Method': 'GET',
        'Resource': '/elements?selectedFields=WebId;Name;Path&path=\\\\' + encodeURIComponent(target.elementPath)
      }

      if (hasAttributes) {
        _.each(target.attributes, attribute => {
          batchQuery[(batchIndex++).toString()] = {
            'Method': 'GET',
            'Resource': '/elements/{0}/attributes?selectedFields=WebId;Name;Path&nameFilter=' + encodeURIComponent(target.elementPath),
            'Parameters': [
              '$.' + elementBatchId + '.Content.WebId'
            ],
            'ParentIds': [
              elementBatchId.toString()
            ]
          }
        })
      } else {
   
      }
      target.attributes
    })
  }

  /**
   * Resolve PIWebAPI response 'value' data to value - timestamp pairs.
   * 
   * @param {any} value - A list of PIWebAPI values.
   * @param {any} target - The target Grafana metric.
   * @param {any} isSummary - Boolean for tracking if data is of summary class.
   * @returns - An array of Grafana value, timestamp pairs.
   * 
   */
  parsePiPointValueList(value, target, isSummary = false) {
    var api = this;
    var datapoints = [];
    var previousValue = null;
    _.each(value, item => {
      var grafanaDataPoint = api.parsePiPointValue(item, isSummary, target);
      var drop = false;
      if (isSummary){
        grafanaDataPoint, previousValue, drop = this.noDataReplace(item.Value, target.summary.nodata, grafanaDataPoint)
      } else{
        grafanaDataPoint, previousValue, drop = this.noDataReplace(item, target.summary.nodata, grafanaDataPoint)
      }
      if (!drop) {
        datapoints.push(grafanaDataPoint)
      }
    })
    return datapoints;
  }
  
  /**
   * Convert a PI Point value to use Grafana value/timestamp.
   * 
   * @param {any} value - PI Point value.
   * @param {any} isSummary - Boolean for tracking if data is of summary class.
   * @param {any} target - The target grafana metric.
   * @returns - Grafana value pair.
   * 
   */
  parsePiPointValue (value, isSummary = false, target) {
    var num = (!isSummary && typeof value.Value === "object") ? Number(value.Value.Value) : Number(value.Value)
    var text = value.Value
    
    if (target.digitalStates && target.digitalStates.enable) {
       num = value.Value.Name
    }

    if (!value.Good) {
      num = value.Value.Name
    }

    if (isSummary) {
      num = Number(value.Value.Value)
      text = value.Value.Value

      if (target.digitalStates && target.digitalStates.enable) {
        num = value.Value.Name
      }

      if (!value.Value.Good) {
        num = value.Value.Name
      }

      if (target.summary.interval == ""){
         if (target.digitalStates && target.digitalStates.enable) {
            return [num, new Date(value.Timestamp).getTime()]
          } else if (!value.Good) {
            return [num, new Date(value.Timestamp).getTime()]
          } else {
            return [(!isNaN(num) ? num : text), new Date(target.endTime).getTime()]
          }
        }

        if (target.digitalStates && target.digitalStates.enable) {
          return [num, new Date(value.Timestamp).getTime()]
        }  else if (!value.Good) {
          return [num, new Date(value.Timestamp).getTime()]
        } else {
          return [(!isNaN(num) ? num : text), new Date(value.Value.Timestamp).getTime()]
        }
      }
      if (target.digitalStates && target.digitalStates.enable) {
        return [num, new Date(value.Timestamp).getTime()]
      } else if (!value.Good) {
        return [num, new Date(value.Timestamp).getTime()]
      } else {
        return [(!isNaN(num) ? num : text), new Date(value.Timestamp).getTime()]
    }    
    return [(!isNaN(num) ? num : 0), new Date(value.Timestamp).getTime()]
  }

  /**
   * Resolve PIWebAPI response 'value' data to value - timestamp pairs.
   * 
   * @param {any} item - 'Item' object from PIWebAPI
   * @param {any} noDataReplacementMode - String state of how to replace 'No Data'
   * @param {any} grafanaDataPoint - Single Grafana value pair (value, timestamp).
   * @returns grafanaDataPoint - Single Grafana value pair (value, timestamp).
   * @returns perviousValue - {any} Grafana value (value only). 
   * 
   */
  noDataReplace(item, noDataReplacementMode, grafanaDataPoint){
    var previousValue = null;
    var drop = false;
    if (item.Value === 'No Data' || (item.Value.Name && item.Value.Name === 'No Data') || !item.Good) {
      if (noDataReplacementMode === 'Drop') {
        drop = true;
      } else if (noDataReplacementMode === '0') {
        grafanaDataPoint[0] = 0;
      } else if (noDataReplacementMode === 'Keep') {
        // Do nothing keep
      } else if (noDataReplacementMode === 'Null') {
        grafanaDataPoint[0] = null;
      } else if (noDataReplacementMode === 'Previous' && previousValue !== null) {
        grafanaDataPoint[0] = previousValue;
      }
    } else {
      previousValue = item.Value;
    }
    return grafanaDataPoint, previousValue, drop
  }

  /**
   * Process the response from PI Web API for a single item.
   * 
   * @param {any} content - Web response data.
   * @param {any} target - The target grafana metric.
   * @param {any} name - The target metric name.
   * @returns - Parsed metric in target/datapoint json format.
   * 
   * @memberOf PiWebApiDatasource
   */
  processResults (content, target, name) {
    var api = this
    var isSummary = target.summary && target.summary.types && target.summary.types.length > 0
    if (target.regex && target.regex.enable) {
      name = name.replace(new RegExp(target.regex.search), target.regex.replace)
    }
    if (isSummary) {
      var innerResults = []
      var groups = _.groupBy(content.Items, item => { return item.Type })
      _.forOwn(groups, (value, key) => {
        innerResults.push({
          'target': name + '[' + key + ']',
          'datapoints': api.parsePiPointValueList(value, target, isSummary)
        })
      })
      return innerResults
    }
    return [{
      'target': name,
      'datapoints': api.parsePiPointValueList(content.Items, target, isSummary)
    }]
    // }).catch(err => { api.error = err }))
  }

  /**
   * Gets historical data from a PI Web API stream source.
   * 
   * @param {any} query - Grafana query.
   * @returns - Metric data.
   * 
   * @memberOf PiWebApiDatasource
   */
  getStream (query) {
    var api = this
    var results = []

    _.each(query.targets, target => {
      target.attributes = _.filter(target.attributes || [], attribute => { return (1 && attribute) })
      var url = ''
      var isSummary = target.summary && target.summary.types && target.summary.types.length > 0
      var isInterpolated = target.interpolate && target.interpolate.enable
      // perhaps add a check to see if interpolate override time < query.interval
      var intervalTime = ((target.interpolate.interval) ? target.interpolate.interval : query.interval)
      var timeRange = '?startTime=' + query.range.from.toJSON() + '&endTime=' + query.range.to.toJSON()
      var targetName = target.expression || target.elementPath
      if (target.expression) {
        url += '/calculation'
        if (isSummary) {
          url += '/summary' + timeRange + (isInterpolated ? '&sampleType=Interval&sampleInterval=' + intervalTime : '')
        } else {
          url += '/intervals' + timeRange + '&sampleInterval=' + intervalTime
        }
        url += '&expression=' + encodeURIComponent(target.expression)
        url += '&webid='
        if (target.attributes.length > 0) {
          _.each(target.attributes, attribute => {
            results.push(
              api.restGetWebId(target.elementPath + '|' + attribute, target.isPiPoint)
              .then(webidresponse => {
                return api.restPost(url + webidresponse.WebId)
                .then(response => { return api.processResults(response.data, target, target.display || attribute || targetName) })
                .catch(err => { api.error = err })
              }))
          })
        } else {
          results.push(
            api.restGetWebId(target.elementPath, target.isPiPoint)
              .then(webidresponse => {
                return api.restPost(url + webidresponse.WebId)
                .then(response => { return api.processResults(response.data, target, target.display || targetName) })
                .catch(err => { api.error = err })
              }))
        }

      } else {
        url += '/streamsets'
        if (isSummary) {
          url += '/summary' + timeRange + '&intervals=' + query.maxDataPoints + this.getSummaryUrl(target.summary)
        } else if (target.interpolate && target.interpolate.enable) {
          url += '/interpolated' + timeRange + '&interval=' + intervalTime
        } else if (target.recordedValues && target.recordedValues.enable) {
          url += '/recorded' + timeRange + '&maxCount=' + target.recordedValues.maxNumber
        } else {
          url += '/plot' + timeRange + '&intervals=' + query.maxDataPoints
        }

        results.push(api.$q.all(_.map(target.attributes, attribute => { return api.restGetWebId(target.elementPath + '|' + attribute, target.isPiPoint) }))
        .then(webidresponse => {
          var query = {};
          _.each(webidresponse, function(webid, index) {
            query[index + 1] = {
              "Method": "GET",
              "Resource": api.piwebapiurl + url + '&webid=' + webid.WebId
            }
          });

          return api.restBatch(query)
            .then(response => {
              var targetResults = []
              _.each(response.data, (value, key) => {
                _.each(value.Content.Items, item => {
                  _.each(api.processResults(item, target, target.display || item.Name || targetName), targetResult => { targetResults.push(targetResult) })
                })
              })
              
              return targetResults
            })
            .catch(err => { api.error = err })
        }))
      }
    })

    return results
  }

  /**
   * Abstraction for calling the PI Web API REST endpoint
   * 
   * @param {any} path - the path to append to the base server URL.
   * @returns - The full URL.
   * 
   * @memberOf PiWebApiDatasource
   */
  restGet (path) {
    return this.backendSrv.datasourceRequest({
      url: this.url + path,
      method: 'GET',
      headers: { 'Content-Type': 'application/json' }
    })
  }

  /**
   * Resolve a Grafana query into a PI Web API webid. Uses client side cache when possible to reduce lookups.
   * 
   * @param {any} assetPath - The AF Path or the Pi Point Path (\\ServerName\piPointName) to the asset.
   * @returns - URL query parameters.
   * 
   * @memberOf PiWebApiDatasource
   */
  restGetWebId (assetPath, isPiPoint) {
    var ds = this

    // check cache
    var cachedWebId = ds.webidCache.get(assetPath)
    if (cachedWebId) {
      return ds.$q.when({Path: assetPath, WebId: cachedWebId})
    }

    if (!isPiPoint){
      // no cache hit, query server
      var path = ((assetPath.indexOf('|') >= 0)
        ? '/attributes?selectedFields=WebId;Name;Path&path=\\\\'
        : '/elements?selectedFields=WebId;Name;Path&path=\\\\') + assetPath
    } else {
      var path = '/points?selectedFields=WebId;Name;Path&path=\\\\' + assetPath.replace('|', '\\')
    }

    

    return this.backendSrv.datasourceRequest({
      url: this.url + path,
      method: 'GET',
      headers: { 'Content-Type': 'application/json' }
    }).then(response => {
      ds.webidCache.put(assetPath, response.data.WebId)
      return { Path: assetPath, WebId: response.data.WebId }
    })
  }

  /**
   * Execute a batch query on the PI Web API.
   * 
   * @param {any} batch - Batch JSON query data.
   * @returns - Batch response.
   * 
   * @memberOf PiWebApiDatasource
   */
  restBatch (batch) {
    return this.backendSrv.datasourceRequest({
      url: this.url + '/batch',
      data: batch,
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'X-Requested-With': 'message/http'
      }
    })
  }

  /**
   * Execute a POST on the PI Web API.
   * 
   * @param {any} path - The full url of the POST.
   * @returns - POST response data.
   * 
   * @memberOf PiWebApiDatasource
   */
  restPost (path) {
    return this.backendSrv.datasourceRequest({
      url: this.url,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'message/http',
        'X-PIWEBAPI-HTTP-METHOD': 'GET',
        'X-PIWEBAPI-RESOURCE-ADDRESS': path
      }
    })
  }

  // Get a list of all data (PI) servers
  getDataServers () {
    return this.restGet('/dataservers')
    .then(response => { return response.data.Items })
  }
  getDataServer (name) {
    return this.restGet('/dataservers?name=' + name)
    .then(response => { return response.data })
  }
  // Get a list of all asset (AF) servers
  getAssetServers () {
    return this.restGet('/assetservers')
      .then(response => { return response.data.Items })
  }
  getAssetServer (name) {
    return this.restGet('/assetservers?path=\\\\' + name)
      .then(response => { return response.data })
  }
  getDatabase (path) {
    return this.restGet('/assetdatabases?path=\\\\' + path)
      .then(response => { return response.data })
  }
  getDatabases (serverId, options) {
    return this.restGet('/assetservers/' + serverId + '/assetdatabases')
      .then(response => { return response.data.Items })
  }
  getElement (path) {
    return this.restGet('/elements?path=\\\\' + path)
      .then(response => { return (response.data) })
  }
  getEventFrameTemplates (databaseId) {
    return this.restGet('/assetdatabases/' + databaseId + '/elementtemplates?selectedFields=Items.InstanceType;Items.Name;Items.WebId')
      .then(response => {
        return _.filter(response.data.Items, item => {
          return item.InstanceType === 'EventFrame'
        })
      })
  }
  getElementTemplates (databaseId) {
    return this.restGet('/assetdatabases/' + databaseId + '/elementtemplates?selectedFields=Items.InstanceType;Items.Name;Items.WebId')
      .then(response => {
        return _.filter(response.data.Items, item => {
          return item.InstanceType === 'Element'
        })
      })
  }

  /**
   * @description
   * Get the child attributes of the current resource.
   * GET attributes/{webId}/attributes
   * @param {string} elementId - The ID of the parent resource. See WebID for more information.
   * @param {Object} options - Query Options
   * @param {string} options.nameFilter - The name query string used for finding attributes. The default is no filter. See Query String for more information.
   * @param {string} options.categoryName - Specify that returned attributes must have this category. The default is no category filter.
   * @param {string} options.templateName - Specify that returned attributes must be members of this template. The default is no template filter.
   * @param {string} options.valueType - Specify that returned attributes' value type must be the given value type. The default is no value type filter.
   * @param {string} options.searchFullHierarchy - Specifies if the search should include attributes nested further than the immediate attributes of the searchRoot. The default is 'false'.
   * @param {string} options.sortField - The field or property of the object used to sort the returned collection. The default is 'Name'.
   * @param {string} options.sortOrder - The order that the returned collection is sorted. The default is 'Ascending'.
   * @param {string} options.startIndex - The starting index (zero based) of the items to be returned. The default is 0.
   * @param {string} options.showExcluded - Specified if the search should include attributes with the Excluded property set. The default is 'false'.
   * @param {string} options.showHidden - Specified if the search should include attributes with the Hidden property set. The default is 'false'.
   * @param {string} options.maxCount - The maximum number of objects to be returned per call (page size). The default is 1000.
   * @param {string} options.selectedFields - List of fields to be returned in the response, separated by semicolons (;). If this parameter is not specified, all available fields will be returned. See Selected Fields for more information.
   */
  getAttributes (elementId, options) {
    var querystring = '?' + _.map(options, function (value, key) {
      return key + '=' + value
    }).join('&')

    if (querystring === '?') { querystring = '' }

    return this.restGet('/elements/' + elementId + '/attributes' + querystring)
      .then(response => { return response.data.Items })
  }

  /**
   * @description
   * Retrieve elements based on the specified conditions. By default, this method selects immediate children of the current resource.
   * Users can search for the elements based on specific search parameters. If no parameters are specified in the search, the default values for each parameter will be used and will return the elements that match the default search.
   * GET assetdatabases/{webId}/elements
   * @param {string} databaseId - The ID of the parent resource. See WebID for more information.
   * @param {Object} options - Query Options
   * @param {string} options.webId - The ID of the resource to use as the root of the search. See WebID for more information.
   * @param {string} options.nameFilter - The name query string used for finding objects. The default is no filter. See Query String for more information.
   * @param {string} options.categoryName - Specify that returned elements must have this category. The default is no category filter.
   * @param {string} options.templateName - Specify that returned elements must have this template or a template derived from this template. The default is no template filter.
   * @param {string} options.elementType - Specify that returned elements must have this type. The default type is 'Any'. See Element Type for more information.
   * @param {string} options.searchFullHierarchy - Specifies if the search should include objects nested further than the immediate children of the searchRoot. The default is 'false'.
   * @param {string} options.sortField - The field or property of the object used to sort the returned collection. The default is 'Name'.
   * @param {string} options.sortOrder - The order that the returned collection is sorted. The default is 'Ascending'.
   * @param {number} options.startIndex - The starting index (zero based) of the items to be returned. The default is 0.
   * @param {number} options.maxCount - The maximum number of objects to be returned per call (page size). The default is 1000.
   * @param {string} options.selectedFields -  List of fields to be returned in the response, separated by semicolons (;). If this parameter is not specified, all available fields will be returned. See Selected Fields for more information.
   */
  getDatabaseElements (databaseId, options) {
    var querystring = '?' + _.map(options, function (value, key) {
      return key + '=' + value
    }).join('&')

    if (querystring === '?') { querystring = '' }

    return this.restGet('/assetdatabases/' + databaseId + '/elements' + querystring)
      .then(response => { return response.data.Items })
  }

  /**
   * @description
   * Retrieve elements based on the specified conditions. By default, this method selects immediate children of the current resource.
   * Users can search for the elements based on specific search parameters. If no parameters are specified in the search, the default values for each parameter will be used and will return the elements that match the default search.
   * GET elements/{webId}/elements
   * @param {string} databaseId - The ID of the resource to use as the root of the search. See WebID for more information.
   * @param {Object} options - Query Options
   * @param {string} options.webId - The ID of the resource to use as the root of the search. See WebID for more information.
   * @param {string} options.nameFilter - The name query string used for finding objects. The default is no filter. See Query String for more information.
   * @param {string} options.categoryName - Specify that returned elements must have this category. The default is no category filter.
   * @param {string} options.templateName - Specify that returned elements must have this template or a template derived from this template. The default is no template filter.
   * @param {string} options.elementType - Specify that returned elements must have this type. The default type is 'Any'. See Element Type for more information.
   * @param {string} options.searchFullHierarchy - Specifies if the search should include objects nested further than the immediate children of the searchRoot. The default is 'false'.
   * @param {string} options.sortField - The field or property of the object used to sort the returned collection. The default is 'Name'.
   * @param {string} options.sortOrder - The order that the returned collection is sorted. The default is 'Ascending'.
   * @param {number} options.startIndex - The starting index (zero based) of the items to be returned. The default is 0.
   * @param {number} options.maxCount - The maximum number of objects to be returned per call (page size). The default is 1000.
   * @param {string} options.selectedFields -  List of fields to be returned in the response, separated by semicolons (;). If this parameter is not specified, all available fields will be returned. See Selected Fields for more information.
   */
  getElements (elementId, options) {
    var querystring = '?' + _.map(options, function (value, key) {
      return key + '=' + value
    }).join('&')

    if (querystring === '?') { querystring = '' }

    return this.restGet('/elements/' + elementId + '/elements' + querystring)
    .then(response => { return response.data.Items })
  }

  /**
   * Retrieve a list of points on a specified Data Server.
   * 
   * @param {string} serverId - The ID of the server. See WebID for more information.
   * @param {string} nameFilter - A query string for filtering by point name. The default is no filter. *, ?, [ab], [!ab]
   */
  piPointSearch (serverId, nameFilter) {
    return this.restGet('/dataservers/' + serverId + '/points?maxCount=100&nameFilter=' + nameFilter).then(results => {
      return results.data.Items
    })
  }

  /**
   * Get the PI Web API webid or PI Point.
   * 
   * @param {any} target - AF Path or Point name.
   * @returns - webid.
   * 
   * @memberOf PiWebApiDatasource
   */
  getWebId (target) {
    var api = this
    var isAf = target.target.indexOf('\\') >= 0
    var isAttribute = target.target.indexOf('|') >= 0
    if (!isAf && target.target.indexOf('.') === -1) { return api.$q.when([{ WebId: target.target, Name: target.display || target.target }]) }


    if (!isAf) {
      // pi point lookup
      return api.piPointSearch(this.piserver.webid, target.target).then(results => {
        if (results.data.Items === undefined || results.data.Items.length === 0) {
          return [{ WebId: target.target, Name: target.display || target.target }]
        }
        return results.data.Items
      })
    } else if (isAf && isAttribute) {
      // af attribute lookup
      return api.restGet('/attributes?path=\\\\' + target.target).then(results => {
        if (results.data === undefined || results.status !== 200) {
          return [{ WebId: target.target, Name: target.display || target.target }]
        }
        // rewrite name if specified
        results.data.Name = target.display || results.data.Name
        return [results.data]
      })
    } else {
      // af element lookup
      return api.restGet('/elements?path=\\\\' + target.target).then(results => {
        if (results.data === undefined || results.status !== 200) {
          return [{ WebId: target.target, Name: target.display || target.target }]
        }
        // rewrite name if specified
        results.data.Name = target.display || results.data.Name
        return [results.data]
      })
    }
  }
}
