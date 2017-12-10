import _ from 'lodash';
import $ from 'jquery';
import moment from 'moment';
import * as utils from '../datasource-zabbix/utils';
import {PanelCtrl} from 'app/plugins/sdk';
import {triggerPanelOptionsTab} from './options_tab';
import {triggerPanelTriggersTab} from './triggers_tab';
import {migratePanelSchema} from './migrations';

const ZABBIX_DS_ID = 'alexanderzobnin-zabbix-datasource';

export const DEFAULT_TARGET = {
  group: {filter: ""},
  host: {filter: ""},
  application: {filter: ""},
  trigger: {filter: ""}
};

export const DEFAULT_SEVERITY = [
  { priority: 0, severity: 'Not classified',  color: '#B7DBAB', show: true },
  { priority: 1, severity: 'Information',     color: '#82B5D8', show: true },
  { priority: 2, severity: 'Warning',         color: '#E5AC0E', show: true },
  { priority: 3, severity: 'Average',         color: '#C15C17', show: true },
  { priority: 4, severity: 'High',            color: '#BF1B00', show: true },
  { priority: 5, severity: 'Disaster',        color: '#890F02', show: true }
];

const DEFAULT_TIME_FORMAT = "DD MMM YYYY HH:mm:ss";

export const PANEL_DEFAULTS = {
  schemaVersion: 3,
  datasources: [],
  targets: {},
  // Fields
  hostField: true,
  hostTechNameField: false,
  statusField: true,
  severityField: true,
  // Options
  hideHostsInMaintenance: false,
  showTriggers: 'all triggers',
  sortTriggersBy: { text: 'last change', value: 'lastchange' },
  showEvents: { text: 'Problems', value: '1' },
  limit: 10,
  // View options
  fontSize: '100%',
  pageSize: 10,
  customLastChangeFormat: false,
  lastChangeFormat: "",
  // Triggers severity and colors
  triggerSeverity: DEFAULT_SEVERITY,
  okEventColor: 'rgba(0, 245, 153, 0.45)',
  ackEventColor: 'rgba(0, 0, 0, 0)'
};

const triggerStatusMap = {
  '0': 'OK',
  '1': 'PROBLEM'
};

export class TriggerPanelCtrl extends PanelCtrl {

  /** @ngInject */
  constructor($scope, $injector, $element, datasourceSrv, templateSrv, contextSrv, dashboardSrv) {
    super($scope, $injector);
    this.datasourceSrv = datasourceSrv;
    this.templateSrv = templateSrv;
    this.contextSrv = contextSrv;
    this.dashboardSrv = dashboardSrv;
    this.scope = $scope;

    this.editorTabIndex = 1;
    this.triggerStatusMap = triggerStatusMap;
    this.defaultTimeFormat = DEFAULT_TIME_FORMAT;
    this.pageIndex = 0;
    this.triggerList = [];
    this.currentTriggersPage = [];
    this.datasources = {};

    this.panel = migratePanelSchema(this.panel);
    _.defaults(this.panel, _.cloneDeep(PANEL_DEFAULTS));

    this.available_datasources = _.map(this.getZabbixDataSources(), 'name');
    if (this.panel.datasources.length === 0) {
      this.panel.datasources.push(this.available_datasources[0]);
    }
    if (_.isEmpty(this.panel.targets)) {
      this.panel.targets[this.panel.datasources[0]] = DEFAULT_TARGET;
    }

    this.initDatasources();
    this.events.on('init-edit-mode', this.onInitEditMode.bind(this));
    this.events.on('refresh', this.onRefresh.bind(this));
  }

  initDatasources() {
    let promises = _.map(this.panel.datasources, (ds) => {
      // Load datasource
      return this.datasourceSrv.get(ds)
      .then(datasource => {
        this.datasources[ds] = datasource;
        return datasource;
      });
    });
    return Promise.all(promises);
  }

  getZabbixDataSources() {
    return _.filter(this.datasourceSrv.getMetricSources(), datasource => {
      return datasource.meta.id === ZABBIX_DS_ID && datasource.value;
    });
  }

  onInitEditMode() {
    this.addEditorTab('Triggers', triggerPanelTriggersTab, 1);
    this.addEditorTab('Options', triggerPanelOptionsTab, 2);
  }

  setTimeQueryStart() {
    this.timing.queryStart = new Date().getTime();
  }

  setTimeQueryEnd() {
    this.timing.queryEnd = new Date().getTime();
  }

  onRefresh() {
    // ignore fetching data if another panel is in fullscreen
    if (this.otherPanelInFullscreenMode()) { return; }

    // clear loading/error state
    delete this.error;
    this.loading = true;
    this.setTimeQueryStart();
    this.pageIndex = 0;

    return this.getTriggers()
    .then(triggerList => {
      // Notify panel that request is finished
      this.loading = false;
      this.setTimeQueryEnd();

      // Limit triggers number
      this.triggerList = triggerList.slice(0, this.panel.limit);
      this.render(this.triggerList);
    })
    .catch(err => {
      // if cancelled  keep loading set to true
      if (err.cancelled) {
        console.log('Panel request cancelled', err);
        return;
      }

      this.loading = false;
      this.error = err.message || "Request Error";

      if (err.data) {
        if (err.data.message) {
          this.error = err.data.message;
        }
        if (err.data.error) {
          this.error = err.data.error;
        }
      }

      this.events.emit('data-error', err);
      console.log('Panel data error:', err);
    });
  }

  render(triggerList) {
    let triggers = this.triggerList;

    if (triggerList) {
      triggers = _.map(triggers, this.formatTrigger.bind(this));
    } else {
      triggers = _.map(triggers, this.updateTriggerFormat.bind(this));
    }
    triggers = this.sortTriggers(triggers);
    this.triggerList = triggers;
    this.getCurrentTriggersPage();
    // this.scope.$digest();

    return super.render(this.triggerList);
  }

  getTriggers() {
    let promises = _.map(this.panel.datasources, (ds) => {
      return this.datasourceSrv.get(ds)
      .then(datasource => {
        var zabbix = datasource.zabbix;
        var showEvents = this.panel.showEvents.value;
        var triggerFilter = this.panel.targets[ds];
        var hideHostsInMaintenance = this.panel.hideHostsInMaintenance;

        // Replace template variables
        var groupFilter = datasource.replaceTemplateVars(triggerFilter.group.filter);
        var hostFilter = datasource.replaceTemplateVars(triggerFilter.host.filter);
        var appFilter = datasource.replaceTemplateVars(triggerFilter.application.filter);

        let triggersOptions = {
          showTriggers: showEvents,
          hideHostsInMaintenance: hideHostsInMaintenance
        };

        return zabbix.getTriggers(groupFilter, hostFilter, appFilter, triggersOptions);
      }).then((triggers) => {
        return this.getAcknowledges(triggers, ds);
      }).then((triggers) => {
        return this.filterTriggers(triggers, ds);
      });
    });

    return Promise.all(promises)
    .then(results => _.flatten(results));
  }

  getAcknowledges(triggerList, ds) {
    // Request acknowledges for trigger
    var eventids = _.map(triggerList, trigger => {
      return trigger.lastEvent.eventid;
    });

    return this.datasources[ds].zabbix.getAcknowledges(eventids)
    .then(events => {

      // Map events to triggers
      _.each(triggerList, trigger => {
        var event = _.find(events, event => {
          return event.eventid === trigger.lastEvent.eventid;
        });

        if (event) {
          trigger.acknowledges = _.map(event.acknowledges, ack => {
            let timestamp = moment.unix(ack.clock);
            if (this.panel.customLastChangeFormat) {
              ack.time = timestamp.format(this.panel.lastChangeFormat);
            } else {
              ack.time = timestamp.format(this.defaultTimeFormat);
            }
            ack.user = ack.alias + ' (' + ack.name + ' ' + ack.surname + ')';
            return ack;
          });
        }
      });

      return triggerList;
    });
  }

  filterTriggers(triggerList, ds) {
    // Filter triggers by description
    var triggerFilter = this.panel.targets[ds].trigger.filter;
    triggerFilter = this.datasources[ds].replaceTemplateVars(triggerFilter);
    if (triggerFilter) {
      triggerList = filterTriggers(triggerList, triggerFilter);
    }

    // Filter acknowledged triggers
    if (this.panel.showTriggers === 'unacknowledged') {
      triggerList = _.filter(triggerList, trigger => {
        return !trigger.acknowledges;
      });
    } else if (this.panel.showTriggers === 'acknowledged') {
      triggerList = _.filter(triggerList, 'acknowledges');
    } else {
      triggerList = triggerList;
    }

    // Filter triggers by severity
    triggerList = _.filter(triggerList, trigger => {
      return this.panel.triggerSeverity[trigger.priority].show;
    });

    return triggerList;
  }

  sortTriggers(triggerList) {
    if (this.panel.sortTriggersBy.value === 'priority') {
      triggerList = _.sortBy(triggerList, ['priority', 'triggerid']).reverse();
    } else {
      triggerList = _.sortBy(triggerList, ['lastchangeUnix', 'triggerid']).reverse();
    }
    return triggerList;
  }

  formatTrigger(zabbixTrigger) {
    let trigger = _.cloneDeep(zabbixTrigger);
    let triggerObj = trigger;

    // Set host that the trigger belongs
    if (trigger.hosts.length) {
      triggerObj.host = trigger.hosts[0].name;
      triggerObj.hostTechName = trigger.hosts[0].host;
    }

    // Format last change and age
    trigger.lastchangeUnix = Number(trigger.lastchange);
    triggerObj = this.setTriggerLastChange(triggerObj);
    triggerObj = this.setTriggerSeverity(triggerObj);
    return triggerObj;
  }

  updateTriggerFormat(trigger) {
    trigger = this.setTriggerLastChange(trigger);
    trigger = this.setTriggerSeverity(trigger);
    return trigger;
  }

  setTriggerSeverity(trigger) {
    if (trigger.value === '1') {
      // Problem state
      trigger.color = this.panel.triggerSeverity[trigger.priority].color;
    } else {
      // OK state
      trigger.color = this.panel.okEventColor;
    }
    trigger.severity = this.panel.triggerSeverity[trigger.priority].severity;

    // Mark acknowledged triggers with different color
    if (this.panel.markAckEvents && trigger.acknowledges && trigger.acknowledges.length) {
      trigger.color = this.panel.ackEventColor;
    }

    return trigger;
  }

  setTriggerLastChange(trigger) {
    let timestamp = moment.unix(trigger.lastchangeUnix);
    if (this.panel.customLastChangeFormat) {
      // User defined format
      trigger.lastchange = timestamp.format(this.panel.lastChangeFormat);
    } else {
      trigger.lastchange = timestamp.format(this.defaultTimeFormat);
    }
    trigger.age = timestamp.fromNow(true);
    return trigger;
  }

  switchComment(trigger) {
    trigger.showComment = !trigger.showComment;
  }

  acknowledgeTrigger(trigger, message) {
    let eventid = trigger.lastEvent.eventid;
    let grafana_user = this.contextSrv.user.name;
    let ack_message = grafana_user + ' (Grafana): ' + message;
    return this.datasourceSrv.get(this.panel.datasource)
    .then(datasource => {
      let zabbixAPI = datasource.zabbix.zabbixAPI;
      return zabbixAPI.acknowledgeEvent(eventid, ack_message);
    })
    .then(this.onRefresh.bind(this));
  }

  getCurrentTriggersPage() {
    let pageSize = this.panel.pageSize || 10;
    let startPos = this.pageIndex * pageSize;
    let endPos = Math.min(startPos + pageSize, this.triggerList.length);
    this.currentTriggersPage = this.triggerList.slice(startPos, endPos);
    return this.currentTriggersPage;
  }

  formatHostName(trigger) {
    if (this.panel.hostField && this.panel.hostTechNameField) {
      return `${trigger.host} (${trigger.hostTechName})`;
    } else if (this.panel.hostField || this.panel.hostTechNameField) {
      return trigger.host || trigger.hostTechName;
    } else {
      return "";
    }
  }

  link(scope, elem, attrs, ctrl) {
    let panel = ctrl.panel;
    let pageCount = 0;
    let data = ctrl.triggerList;

    function getContentHeight() {
      let panelHeight = ctrl.height;

      if (pageCount > 1) {
        panelHeight -= 36;
      }

      return panelHeight + 'px';
    }

    function switchPage(e) {
      let el = $(e.currentTarget);
      ctrl.pageIndex = (parseInt(el.text(), 10)-1);

      let pageSize = ctrl.panel.pageSize || 10;
      let startPos = ctrl.pageIndex * pageSize;
      let endPos = Math.min(startPos + pageSize, ctrl.triggerList.length);
      ctrl.currentTriggersPage = ctrl.triggerList.slice(startPos, endPos);

      scope.$apply(() => {
        renderPanel();
      });
    }

    function appendPaginationControls(footerElem) {
      footerElem.empty();

      let pageSize = ctrl.panel.pageSize || 5;
      pageCount = Math.ceil(data.length / pageSize);
      if (pageCount === 1) {
        return;
      }

      let startPage = Math.max(ctrl.pageIndex - 3, 0);
      let endPage = Math.min(pageCount, startPage + 9);

      let paginationList = $('<ul></ul>');

      for (let i = startPage; i < endPage; i++) {
        let activeClass = i === ctrl.pageIndex ? 'active' : '';
        let pageLinkElem = $('<li><a class="triggers-panel-page-link pointer ' + activeClass + '">' + (i+1) + '</a></li>');
        paginationList.append(pageLinkElem);
      }

      footerElem.append(paginationList);
    }

    function setFontSize() {
      const fontSize = parseInt(panel.fontSize.slice(0, panel.fontSize.length - 1));
      let triggerCardElem = elem.find('.card-item-wrapper');
      console.log(fontSize);
      if (fontSize && fontSize !== 100) {
        triggerCardElem.find('.alert-list-icon').css({'font-size': fontSize + '%'});
        triggerCardElem.find('.alert-list-title').css({'font-size': fontSize + '%'});
        triggerCardElem.find('.alert-list-text').css({'font-size': fontSize * 0.7 + '%'});
      } else {
        // remove css
        triggerCardElem.find('.alert-list-icon').css({'font-size': ''});
        triggerCardElem.find('.alert-list-title').css({'font-size': ''});
        triggerCardElem.find('.alert-list-text').css({'font-size': ''});
      }
    }

    function renderPanel() {
      let rootElem = elem.find('.triggers-panel-scroll');
      let footerElem = elem.find('.triggers-panel-footer');
      appendPaginationControls(footerElem);
      rootElem.css({'max-height': getContentHeight()});
      rootElem.css({'height': getContentHeight()});
      setFontSize();
      ctrl.renderingCompleted();
    }

    elem.on('click', '.triggers-panel-page-link', switchPage);

    let unbindDestroy = scope.$on('$destroy', function() {
      elem.off('click', '.triggers-panel-page-link');
      unbindDestroy();
    });

    function onRender(renderData)  {
      if (renderData) {
        renderData = _.map(renderData, ctrl.formatTrigger.bind(ctrl));
        data = renderData;
      } else {
        data = _.map(data, ctrl.updateTriggerFormat.bind(ctrl));
      }
      data = ctrl.sortTriggers(data);
      if (data) {
        ctrl.triggerList = data;
        ctrl.getCurrentTriggersPage();
      }
      renderPanel();
    }

    ctrl.events.on('render', (renderData) => {
      // onRender(renderData);
      renderPanel();
    });
  }
}

TriggerPanelCtrl.templateUrl = 'public/plugins/alexanderzobnin-zabbix-app/panel-triggers/partials/module.html';

function filterTriggers(triggers, triggerFilter) {
  if (utils.isRegex(triggerFilter)) {
    return _.filter(triggers, function(trigger) {
      return utils.buildRegex(triggerFilter).test(trigger.description);
    });
  } else {
    return _.filter(triggers, function(trigger) {
      return trigger.description === triggerFilter;
    });
  }
}
