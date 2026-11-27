function i(a,t,r){const s=t-a,c=Math.min(Math.max(r,.001),s||1),o=Math.max(a,0)+c,e=a<-1e-4*Math.max(s,1e-6)&&t>0,n=e?Math.max(t*1.001+1e-4,o):o;return{far:n,slabN:o/n,sunk:e}}const l="gl_FragColor = vec4( vec3( 1.0 - fragCoordZ ), opacity );",d=`uniform float darkness;
uniform float slabN;
uniform float sunk;
`,f=`
	float nkdZ = fragCoordZ / slabN;
	if ( gl_FrontFacing ) {
		// Past the slab a front face casts nothing but is NOT discarded: it still has to win the
		// depth test, or the back face behind it would be read as "the camera is inside".
		gl_FragColor = vec4( vec3( 0.0 ), max( 1.0 - nkdZ, 0.0 ) * darkness );
	} else {
		if ( sunk < 0.5 ) discard;
		gl_FragColor = vec4( vec3( 0.0 ), darkness );
	}`;export{f as CONTACT_FRAG,l as CONTACT_FRAG_FIND,d as CONTACT_FRAG_UNIFORMS,i as contactRange};
