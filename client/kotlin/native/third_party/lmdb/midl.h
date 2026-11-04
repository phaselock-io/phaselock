/*!
 * Vendored from LMDB by Howard Chu, Symas Corp.,
 * https://github.com/LMDB/lmdb, file libraries/liblmdb/midl.h,
 * at commit 028f61b6832032174f893484719ed4848d8d60db (version 0.9.36).
 * Unmodified.
 *
 * SPDX-License-Identifier: OLDAP-2.8
 *
 * Copyright 2011-2021 Howard Chu, Symas Corp.
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted only as authorized by the OpenLDAP
 * Public License.
 *
 * A copy of this license is available in the file LICENSE in the
 * top-level directory of the distribution or, alternatively, at
 * <http://www.OpenLDAP.org/license.html>.
 *
 * OpenLDAP is a registered trademark of the OpenLDAP Foundation.
 *
 * Individual files and/or contributed packages may be copyright by
 * other parties and/or subject to additional restrictions.
 *
 * This work also contains materials derived from public sources.
 *
 * Additional information about OpenLDAP can be obtained at
 * <http://www.openldap.org/>.
 *
 * The OpenLDAP Public License
 *   Version 2.8, 17 August 2003
 *
 * Redistribution and use of this software and associated documentation
 * ("Software"), with or without modification, are permitted provided
 * that the following conditions are met:
 *
 * 1. Redistributions in source form must retain copyright statements
 *    and notices,
 *
 * 2. Redistributions in binary form must reproduce applicable copyright
 *    statements and notices, this list of conditions, and the following
 *    disclaimer in the documentation and/or other materials provided
 *    with the distribution, and
 *
 * 3. Redistributions must contain a verbatim copy of this document.
 *
 * The OpenLDAP Foundation may revise this license from time to time.
 * Each revision is distinguished by a version number.  You may use
 * this Software under terms of this license revision or under the
 * terms of any subsequent revision of the license.
 *
 * THIS SOFTWARE IS PROVIDED BY THE OPENLDAP FOUNDATION AND ITS
 * CONTRIBUTORS ``AS IS'' AND ANY EXPRESSED OR IMPLIED WARRANTIES,
 * INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY
 * AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED.  IN NO EVENT
 * SHALL THE OPENLDAP FOUNDATION, ITS CONTRIBUTORS, OR THE AUTHOR(S)
 * OR OWNER(S) OF THE SOFTWARE BE LIABLE FOR ANY DIRECT, INDIRECT,
 * INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING,
 * BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
 * LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT
 * LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN
 * ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
 * POSSIBILITY OF SUCH DAMAGE.
 *
 * The names of the authors and copyright holders must not be used in
 * advertising or otherwise to promote the sale, use or other dealing
 * in this Software without specific, written prior permission.  Title
 * to copyright in this Software shall at all times remain with copyright
 * holders.
 *
 * OpenLDAP is a registered trademark of the OpenLDAP Foundation.
 *
 * Copyright 1999-2003 The OpenLDAP Foundation, Redwood City,
 * California, USA.  All Rights Reserved.  Permission to copy and
 * distribute verbatim copies of this document is granted.
 */
/**	@file midl.h
 *	@brief LMDB ID List header file.
 *
 *	This file was originally part of back-bdb but has been
 *	modified for use in libmdb. Most of the macros defined
 *	in this file are unused, just left over from the original.
 *
 *	This file is only used internally in libmdb and its definitions
 *	are not exposed publicly.
 */
/* $OpenLDAP$ */
/* This work is part of OpenLDAP Software <http://www.openldap.org/>.
 *
 * Copyright 2000-2021 The OpenLDAP Foundation.
 * Portions Copyright 2001-2021 Howard Chu, Symas Corp.
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted only as authorized by the OpenLDAP
 * Public License.
 *
 * A copy of this license is available in the file LICENSE in the
 * top-level directory of the distribution or, alternatively, at
 * <http://www.OpenLDAP.org/license.html>.
 */

#ifndef _MDB_MIDL_H_
#define _MDB_MIDL_H_

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/** @defgroup internal	LMDB Internals
 *	@{
 */

/** @defgroup idls	ID List Management
 *	@{
 */
	/** A generic unsigned ID number. These were entryIDs in back-bdb.
	 *	Preferably it should have the same size as a pointer.
	 */
typedef size_t MDB_ID;

	/** An IDL is an ID List, a sorted array of IDs. The first
	 * element of the array is a counter for how many actual
	 * IDs are in the list. In the original back-bdb code, IDLs are
	 * sorted in ascending order. For libmdb IDLs are sorted in
	 * descending order.
	 */
typedef MDB_ID *MDB_IDL;

/* IDL sizes - likely should be even bigger
 *   limiting factors: sizeof(ID), thread stack size
 */
#ifndef MDB_IDL_LOGN
#define	MDB_IDL_LOGN	16	/* DB_SIZE is 2^16, UM_SIZE is 2^17 */
#endif
#define MDB_IDL_DB_SIZE		(1<<MDB_IDL_LOGN)
#define MDB_IDL_UM_SIZE		(1<<(MDB_IDL_LOGN+1))

#define MDB_IDL_DB_MAX		(MDB_IDL_DB_SIZE-1)
#define MDB_IDL_UM_MAX		(MDB_IDL_UM_SIZE-1)

#define MDB_IDL_SIZEOF(ids)		(((ids)[0]+1) * sizeof(MDB_ID))
#define MDB_IDL_IS_ZERO(ids) ( (ids)[0] == 0 )
#define MDB_IDL_CPY( dst, src ) (memcpy( dst, src, MDB_IDL_SIZEOF( src ) ))
#define MDB_IDL_FIRST( ids )	( (ids)[1] )
#define MDB_IDL_LAST( ids )		( (ids)[(ids)[0]] )

	/** Current max length of an #mdb_midl_alloc()ed IDL */
#define MDB_IDL_ALLOCLEN( ids )	( (ids)[-1] )

	/** Append ID to IDL. The IDL must be big enough. */
#define mdb_midl_xappend(idl, id) do { \
		MDB_ID *xidl = (idl), xlen = ++(xidl[0]); \
		xidl[xlen] = (id); \
	} while (0)

	/** Search for an ID in an IDL.
	 * @param[in] ids	The IDL to search.
	 * @param[in] id	The ID to search for.
	 * @return	The index of the first ID greater than or equal to \b id.
	 */
unsigned mdb_midl_search( MDB_IDL ids, MDB_ID id );

	/** Allocate an IDL.
	 * Allocates memory for an IDL of the given size.
	 * @return	IDL on success, NULL on failure.
	 */
MDB_IDL mdb_midl_alloc(int num);

	/** Free an IDL.
	 * @param[in] ids	The IDL to free.
	 */
void mdb_midl_free(MDB_IDL ids);

	/** Shrink an IDL.
	 * Return the IDL to the default size if it has grown larger.
	 * @param[in,out] idp	Address of the IDL to shrink.
	 */
void mdb_midl_shrink(MDB_IDL *idp);

	/** Make room for num additional elements in an IDL.
	 * @param[in,out] idp	Address of the IDL.
	 * @param[in] num	Number of elements to make room for.
	 * @return	0 on success, ENOMEM on failure.
	 */
int mdb_midl_need(MDB_IDL *idp, unsigned num);

	/** Append an ID onto an IDL.
	 * @param[in,out] idp	Address of the IDL to append to.
	 * @param[in] id	The ID to append.
	 * @return	0 on success, ENOMEM if the IDL is too large.
	 */
int mdb_midl_append( MDB_IDL *idp, MDB_ID id );

	/** Append an IDL onto an IDL.
	 * @param[in,out] idp	Address of the IDL to append to.
	 * @param[in] app	The IDL to append.
	 * @return	0 on success, ENOMEM if the IDL is too large.
	 */
int mdb_midl_append_list( MDB_IDL *idp, MDB_IDL app );

	/** Append an ID range onto an IDL.
	 * @param[in,out] idp	Address of the IDL to append to.
	 * @param[in] id	The lowest ID to append.
	 * @param[in] n		Number of IDs to append.
	 * @return	0 on success, ENOMEM if the IDL is too large.
	 */
int mdb_midl_append_range( MDB_IDL *idp, MDB_ID id, unsigned n );

	/** Merge an IDL onto an IDL. The destination IDL must be big enough.
	 * @param[in] idl	The IDL to merge into.
	 * @param[in] merge	The IDL to merge.
	 */
void mdb_midl_xmerge( MDB_IDL idl, MDB_IDL merge );

	/** Sort an IDL.
	 * @param[in,out] ids	The IDL to sort.
	 */
void mdb_midl_sort( MDB_IDL ids );

	/** An ID2 is an ID/pointer pair.
	 */
typedef struct MDB_ID2 {
	MDB_ID mid;		/**< The ID */
	void *mptr;		/**< The pointer */
} MDB_ID2;

	/** An ID2L is an ID2 List, a sorted array of ID2s.
	 * The first element's \b mid member is a count of how many actual
	 * elements are in the array. The \b mptr member of the first element is unused.
	 * The array is sorted in ascending order by \b mid.
	 */
typedef MDB_ID2 *MDB_ID2L;

	/** Search for an ID in an ID2L.
	 * @param[in] ids	The ID2L to search.
	 * @param[in] id	The ID to search for.
	 * @return	The index of the first ID2 whose \b mid member is greater than or equal to \b id.
	 */
unsigned mdb_mid2l_search( MDB_ID2L ids, MDB_ID id );


	/** Insert an ID2 into a ID2L.
	 * @param[in,out] ids	The ID2L to insert into.
	 * @param[in] id	The ID2 to insert.
	 * @return	0 on success, -1 if the ID was already present in the ID2L.
	 */
int mdb_mid2l_insert( MDB_ID2L ids, MDB_ID2 *id );

	/** Append an ID2 into a ID2L.
	 * @param[in,out] ids	The ID2L to append into.
	 * @param[in] id	The ID2 to append.
	 * @return	0 on success, -2 if the ID2L is too big.
	 */
int mdb_mid2l_append( MDB_ID2L ids, MDB_ID2 *id );

/** @} */
/** @} */
#ifdef __cplusplus
}
#endif
#endif	/* _MDB_MIDL_H_ */
