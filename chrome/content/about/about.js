function init() {
  var rdfs = Components.classes["@mozilla.org/rdf/rdf-service;1"].
                        getService(Components.interfaces.nsIRDFService);
  var extension = rdfs.GetResource('urn:mozilla:item:brief@mozdev.org');  
  var gExtensionDB = Components.classes['@mozilla.org/extensions/manager;1'].
                     getService(Components.interfaces.nsIExtensionManager).
                     QueryInterface(Components.interfaces.nsIExtensionManager_MOZILLA_1_8_BRANCH).
                     datasource;
    
  var extensionsStrings = document.getElementById("extensionsStrings");
  
  // Name       
  var nameArc = rdfs.GetResource(EM_NS("name"));
  var name = gExtensionDB.GetTarget(extension, nameArc, true);
  name = name.QueryInterface(Components.interfaces.nsIRDFLiteral).Value;
  // Version
  var versionArc = rdfs.GetResource(EM_NS("version"));
  var version = gExtensionDB.GetTarget(extension, versionArc, true);
  version = version.QueryInterface(Components.interfaces.nsIRDFLiteral).Value;
  // Description
  var descriptionArc = rdfs.GetResource(EM_NS("description"));
  var description = gExtensionDB.GetTarget(extension, descriptionArc, true);
  if (description)
    description = description.QueryInterface(Components.interfaces.nsIRDFLiteral).Value;
  // Home Page URL
  var homepageArc = rdfs.GetResource(EM_NS("homepageURL"));
  var homepage = gExtensionDB.GetTarget(extension, homepageArc, true);
  if (homepage) {
    homepage = homepage.QueryInterface(Components.interfaces.nsIRDFLiteral).Value;
    // only allow http(s) homepages
    var scheme = "";
    var uri = null;
    try {
      uri = makeURI(homepage);
      scheme = uri.scheme;
    } catch (ex) {}
    if (uri && (scheme == "http" || scheme == "https"))
      homepage = uri.spec;
    else
      homepage = null;
  }
    
  // Creator
  var creatorArc = rdfs.GetResource(EM_NS("creator"));
  var creator = gExtensionDB.GetTarget(extension, creatorArc, true);
  if (creator)
    creator = creator.QueryInterface(Components.interfaces.nsIRDFLiteral).Value;
  
  document.title = extensionsStrings.getFormattedString("aboutWindowTitle", [name]);
  var extensionName = document.getElementById("extensionName");
  extensionName.setAttribute("value", name);
  var extensionVersion = document.getElementById("extensionVersion");
  extensionVersion.setAttribute("value", version);
  
  var extensionDescription = document.getElementById("extensionDescription");
  extensionDescription.appendChild(document.createTextNode(description));
  
  var extensionCreator = document.getElementById("extensionCreator");
  extensionCreator.setAttribute("value", creator);
  
  var extensionHomepage = document.getElementById("extensionHomepage");
  if (homepage) {
    extensionHomepage.setAttribute("homepageURL", homepage);
    extensionHomepage.setAttribute("tooltiptext", homepage);
    extensionHomepage.blur();
  }
  else
    extensionHomepage.hidden = true;
    
  var sectionProps = [["translatorsBox", "translator", "extensionTranslators"],
                      ["contributorsBox", "contributor", "extensionContributors"]];

  for (var i = 0; i < sectionProps.length; ++i) {
    var node = document.getElementById(sectionProps[i][0]);
    var arc = rdfs.GetResource(EM_NS(sectionProps[i][1]));
    var targets = gExtensionDB.GetTargets(extension, arc, true);
    if (!targets.hasMoreElements())
      document.getElementById(sectionProps[i][2]).hidden = true;
    else {
      while (targets.hasMoreElements()) {
        var literalValue = targets.getNext().
                           QueryInterface(Components.interfaces.nsIRDFLiteral).
                           Value;
        var label = document.createElement("label");
        label.setAttribute("value", literalValue);
        label.setAttribute("class", "contributor");
        node.appendChild(label);
      }
    }
  }
    
  var acceptButton = document.documentElement.getButton("accept");
  acceptButton.label = extensionsStrings.getString("aboutWindowCloseButton");
}

function EM_NS(aProperty) {
  return "http://www.mozilla.org/2004/em-rdf#" + aProperty;
}

function loadHomepage(aEvent) {
  window.close();
  window.opener.openURL(aEvent.target.getAttribute("homepageURL"));
}
